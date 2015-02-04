var ready = false;

var ds = {
  numWindow: 0,
  numPos: 0
};

// JSON object to hold metrics for each pair of positions
var metrics = {};
var filtered = {};

// some sort of method to keep track of what the distribution of values looks like
// (populate on loading data)
var threshCounts = {
  'depth': [],
  'variant': [],
  'metric': []
};

// parameters to filter on (eventually make these user-configurable)
var minDepthPercent = 0.25;
var minVariants = 0.1;
var minVarJ = true;
var minMetric = 0.3;

// JSON object to hold the 2x2 matrix of counts for each pair of positions
var counts = {};

// NOTE: adapts the loadBinaryData() function from matrixviewer.js to output
// data in a JSON format

// general function to read in binary data
// assumes three header ints:
// <window_size> <num_pos> <header_flags>
// ... where <header_flags> is a 32-bit int:
//
//                     spacing (# data/element)
// precision (n/a for floats) __  |
//       is int? (n is float)__|  |
//                            ||  |
// is a sparse representation_||  |
//                           |||  |
// uuuuuuuuuuuuuuuuuuuuuuuuuusippnn
var loadBinaryData = function(data, name) {
  ready = false;

  console.time("parsing file " + name);
  updateLoadingStatus("parsing " + name + " file...");

  var dv = new DataView(data);

  var thisNumWindow = dv.getInt32(0);
  var thisNumPos = dv.getInt32(4);

  // parse the header flags
  var headerFlagInt = dv.getInt32(8);
  // headerFlagInt >>= 8; // for some reason, java puts this stuff in the first two bytes?
  var thisSpacing = (headerFlagInt & 3) + 1;
  var precision = ((headerFlagInt & 12) >> 2) + 1;
  var isInt = (headerFlagInt & 16) > 0;
  var isSparse = (headerFlagInt & 32) > 0;

  // do some function definition here based on the header flags
  var headerSize = 12;
  var getDataVal = function(offset) { return DataView.prototype.getFloat32.call(dv, offset); };
  if (isInt) {
    getDataVal = function(offset) { return DataView.prototype.getInt32.call(dv, offset); };
    if (precision == 2) {
      getDataVal = function(offset) { return DataView.prototype.getInt16.call(dv, offset); };
    } else if (precision == 1) {
      getDataVal = function(offset) { return DataView.prototype.getInt8.call(dv, offset); };
    }
  } else {
    precision = 4;
  }

  // do a bunch of error checking (also serves as documentation)
  if (ds.numPos && ds.numPos != thisNumPos) {
    console.warn("number of lines in file %s does not match data: expected %d, depth had %d lines", name, ds.numWindow, thisNumWindow);
  }

  if (ds.numWindow && ds.numWindow != thisNumWindow) {
    console.warn("number of items in a window does not match data in %s: expected %d, depth had a window size of %d", name, ds.numWindow, thisNumWindow);
  }

  var expectedPositions = 0;
  if (isSparse) {
    expectedPositions = (dv.byteLength - headerSize) / (thisSpacing * precision + 4);
    if (expectedPositions % 1 != 0) {
      console.warn("expected to find %d positions of data, found a fraction of %f extra data (each element has %d data values associated of %d bytes of precision each)", expectedPositions, expectedPositions % 1, thisSpacing, precision);

      expectedPositions = Math.floor(expectedPositions);
    }
  } else {
    var expectedBytes = (thisNumWindow * thisNumPos * thisSpacing) * precision + headerSize;
    if (dv.byteLength !== expectedBytes) {
      console.warn("expected to find %d bytes of data from header, found %d instead. unusual truncation may occur", dv.byteLength, expectedBytes);

      if (dv.byteLength < expectedBytes) {
        console.error("missing data designated by header, please check the file. aborting.");
        return false;
      }
    }
  }

  // if we don't have any population of numWindow and numPos, 
  // populate it with this dataset.
  var windowOffset = 0;
  var numPositions = thisNumPos;
  if (ds.numWindow == 0 || ds.numPos == 0) {
    ds.numWindow = thisNumWindow;
    ds.numPos = thisNumPos;
  }

  // set up bounds structure
  if (!metrics.hasOwnProperty('bounds'))
    metrics['bounds'] = {};

  if (thisSpacing > 1) {
    metrics['bounds'][name] = [];
    for (var n = 0; n < thisSpacing; n++) {
      metrics['bounds'][name][n] = {max: -1000000, min: 1000000};
    }
  } else {
    metrics['bounds'][name] = {max: -1000000, min: 1000000};
  }

  // explode out the sparse representation to a full representation for the GPU
  var offset = headerSize;
  if (isSparse) {
    console.log(name + " is sparse...");
    for (var n = 0; n < expectedPositions; n++) {
      var curIndex = dv.getInt32(offset);
      offset += 4;

      // okay, so we have the index (0-indexed); convert into i, j coordinates (1-index)
      var i = Math.floor(curIndex / ds.numWindow) + 1;
      var j = (i - 1) - Math.floor(ds.numWindow / 2) + (curIndex % ds.numWindow) + 1;

      // create an entry for i if it doesn't exist
      if (!metrics.hasOwnProperty(i))
        metrics[i] = {};

      // create an entry for i > j if it doesn't exist
      if (!metrics[i].hasOwnProperty(j))
        metrics[i][j] = {};

      // fill in the metric
      if (thisSpacing > 1) { 
        if (!metrics[i][j].hasOwnProperty(name))
          metrics[i][j][name] = [];
      
        for (var k = 0; k < thisSpacing; k++) {
          var curVal = getDataVal(offset);
          metrics[i][j][name][k] = curVal;
          
          // calculate bounds
          metrics['bounds'][name][k]['max'] = Math.max(metrics['bounds'][name][k]['max'], curVal);
          metrics['bounds'][name][k]['min'] = Math.min(metrics['bounds'][name][k]['min'], curVal);
          
          offset += precision;
        }
      } else {
        var curVal = getDataVal(offset);
        metrics[i][j][name] = curVal;

        // calculate bounds
        metrics['bounds'][name]['max'] = Math.max(metrics['bounds'][name]['max'], curVal);
        metrics['bounds'][name]['min'] = Math.min(metrics['bounds'][name]['min'], curVal);

        // increment the offset counter
        offset += precision;
      }
    }
  } else {
    console.log(name + " is dense...");
    for (var i = 0; i < numPositions; i++) {
      for (var j = windowOffset; j < ds.numWindow - windowOffset; j++) {
        for(var n = 0; n < thisSpacing; n++) {
          var curVal = getDataVal(offset);

          // increment the offset counter
          offset += precision;

          // if this number is zero, don't bother recording it
          if (curVal == 0)
            continue;

          // calculate these indicies (and convert to 1-indexed)
          var index_i = i + 1;
          var index_j = i - Math.floor(ds.numWindow / 2) + j + 1;

          // create an entry for i if it doesn't exist
          if (!metrics.hasOwnProperty(index_i))
            metrics[index_i] = {};

          // create an entry for i > j if it doesn't exist
          if (!metrics[index_i].hasOwnProperty(index_j))
            metrics[index_i][index_j] = {};
            
          // if there is more than one possible value per position pair, 
          // create an entry for i > j > name > n
          if (thisSpacing > 1) {
            if (!metrics[index_i][index_j].hasOwnProperty(name)) 
              metrics[index_i][index_j][name] = [];
            
            metrics[index_i][index_j][name][n] = curVal;
          } else {
            // fill in the metric
            metrics[index_i][index_j][name] = curVal;
          }

          // calculate bounds
          metrics['bounds'][name]['max'] = Math.max(metrics['bounds'][name]['max'], curVal);
          metrics['bounds'][name]['min'] = Math.min(metrics['bounds'][name]['min'], curVal);
        }
      }
    }
  }

  console.timeEnd("parsing file " + name);
  updateLoadingStatus("collecting data...");
  continueIfDone();
};

var makeBinaryFileRequest = function(filename, name) {
  // if a specific name is given, use it; otherwise just use the filename
  // as the identifier
  name = name || filename;

  // jQuery looks too hard here; it's not implemented yet for ArrayBuffer
  // xhr requests, which is an HTML5 phenomenon:
  // http://www.artandlogic.com/blog/2013/11/jquery-ajax-blobs-and-array-buffers/
  var xhr = new XMLHttpRequest();
  xhr.open('GET', filename, true);
  xhr.responseType = 'arraybuffer';

  xhr.addEventListener('load', function() {
    if (xhr.status == 200) {
      loadBinaryData(xhr.response, name);
    } else {
      console.warning("failed to load requested file (status: %d)", xhr.status);
      console.trace();
    }
  });

  xhr.send(null);
};

var continueIfDone = function() {
  
  var theIs = Object.keys(metrics);
  
  // spin until all files have been parsed
  if (theIs.length == 0)
    return;
    
  // get an arbitrary index to play with
  var i = theIs[Math.floor(Math.random() * theIs.length)];
  
  var theJs = Object.keys(metrics[i]);
  var j = theJs[Math.floor(Math.random() * theJs.length)];
  
  var curVal = metrics[i][j];
  if (!curVal.hasOwnProperty('metric') || !curVal.hasOwnProperty('depth') || !curVal.hasOwnProperty('counts')) {
    console.log("still missing fields (" + i + ", " + j + ") .. waiting");
    return;
  }
  
  // try doing the scales
  collectStats();
  makeSlider('depth');
  makeSlider('variant');
  makeSlider('metric');
  
  filterData();
  updateVis();
};

var collectStats = function() {
  // for each element, gather and save distributions of metrics
  console.time('collecting stats');
  
  var is = Object.keys(metrics);
  is.forEach(function(curI) {
    if (curI === 'bounds') return;
    
    var js = Object.keys(metrics[curI]);
    js.forEach(function(curJ) {
      var curPair = metrics[curI][curJ];
      
      if (curPair.hasOwnProperty('depth'))
        threshCounts.depth.push(curPair.depth);
      
      if (curPair.hasOwnProperty('counts')) {
        threshCounts.variant.push(
          Math.min(
            (curPair.counts[2] + curPair.counts[3]) / curPair.depth,
            (curPair.counts[1] + curPair.counts[3]) / curPair.depth
          )
        );
      }
      
      if (curPair.hasOwnProperty('metric'))
        threshCounts.metric.push(Math.abs(curPair.metric));
    });
  });
  
  console.timeEnd('collecting stats');
};  
  
var filterData = function() {
  
  // try to filter out anything that doesn't meet the following criteria
  updateLoadingStatus("filtering data based on thresholds...");
  
  // try filtering on depth
  console.time("filtering");
  filtered = [];
  Object.keys(metrics).forEach(function(i) {
    if (i == 'bounds')
      return;
      
    // coerce to number
    i = +i;
  
    var theJs = Object.keys(metrics[i]);
    theJs.forEach(function(j) {
      var curVal = metrics[i][j];
      
      // heuristic: remove self co-occurrences
      if (i == j)
        return;
      
      // check for minimum depth; quit if fails
      var minDepth = Math.floor(metrics['bounds']['depth']['max'] * minDepthPercent);
      if (!curVal.hasOwnProperty('depth') || curVal.depth < minDepth)
        return;
        
      // calculate the level of variance
      if (!curVal.hasOwnProperty('counts')) {
        console.log("missing counts from " + i + ", " + j);
        return;
      }
      
      var thisLevel = (curVal.counts[2] + curVal.counts[3]) / curVal.depth;
      if (thisLevel < minVariants)
        return;
        
      // do we enforce a minimum variance for j as well?
      thisLevel = (curVal.counts[1] + curVal.counts[3]) / curVal.depth;
      if (minVarJ && thisLevel < minVariants)
        return;
        
      // check for minimum co-occurrence metric
      if (!curVal.hasOwnProperty('metric') || Math.abs(curVal.metric) < minMetric)
        return;
        
      curVal.posi = i;
      curVal.posj = j;
        
      // if all other checks pass, copy to filtered
      // search if this i already exists: add if not, append to existing if so
      var foundExisting = false;
      for (var n = 0; n < filtered.length; n++) {
        var curEntry = filtered[n];
        if (curEntry.pos === i) {
          // TODO: update 'interesting-ness' score for i
          curEntry.relatedPairs.push(curVal);
          curEntry.numFound++;
          foundExisting = true;
          break;
        }
      }
      
      if (!foundExisting) {
        var newEntry = {
          pos: i, 
          numFound: 1, 
          relatedPairs: [curVal], 
          interestingness: 0
        };
        
        filtered.push(newEntry);
      }
    });
  });
  
  console.timeEnd("filtering");
  hideLoading();
};

var loadDataset = function(datasetName, datasetObj) {
  var dataDir = "data/" + datasetName + "/";

  updateLoadingStatus("loading dataset " + datasetName);
  
  makeBinaryFileRequest(dataDir + datasetObj.attenuation, 'depth');
  makeBinaryFileRequest(dataDir + datasetObj.variantCounts, 'counts');
  makeBinaryFileRequest(dataDir + datasetObj.metrics[0], 'metric');
};


var checkFilterEntry = function(i, j) {
  curVal = metrics[i][j];
  
  console.log("---- comparison pos %d to %d", +i, +j);
  
  // check for self co-occurrences
  if (i == j) {
    console.warn("position (%d,%d) is a self co-occurrence; removed.", i, j);
    return;
  }
    
  // check for minimum depth; quit if failsvar minDepth = Math.floor(metrics['bounds']['depth']['max'] * minDepthPercent);
  if (!curVal.hasOwnProperty('depth') || curVal.depth < minDepth) {
    console.warn("position (%d, %d) failed depth check: wanted %f% of %d (%d), found %d (%s%)",
      i, j, Math.floor(minDepthPercent * 100), metrics['bounds']['depth']['max'], minDepth, curVal.depth, (curVal.depth / metrics['bounds']['depth']['max'] * 100).toFixed(2));
    return false;
  }
  
  console.log("passed depth check: %d > %d (%s% > %d%)", curVal.depth, minDepth, (curVal.depth / metrics['bounds']['depth']['max'] * 100).toFixed(2), Math.floor(minDepthPercent * 100));
    
  // calculate the level of variance
  if (!curVal.hasOwnProperty('counts')) {
    console.log("missing counts from " + i + ", " + j);
    return false;
  }
  
  var thisLevel = (curVal.counts[2] + curVal.counts[3]) / curVal.depth;
  if (thisLevel < minVariants) {
    console.warn("position (%d, %d) failed i variant percentage check; wanted %f% for pos %d, got %s% instead", i, j, Math.floor(minVariants * 100), i, (thisLevel * 100).toFixed(2));
    return false;
  }
  
  console.log("passed variant i check: %s% > %f% (%d + %d / %d)", (thisLevel * 100).toFixed(2), Math.floor(minVariants * 100), curVal.counts[2], curVal.counts[3], curVal.depth);
    
  // do we enforce a minimum variance for j as well?
  thisLevel = (curVal.counts[1] + curVal.counts[3]) / curVal.depth;
  if (minVarJ && thisLevel < minVariants) {
    console.warn("position (%d, %d) failed i variant percentage check; wanted %f% for pos %d, got %s% instead", i, j, Math.floor(minVariants * 100), j, (thisLevel * 100).toFixed(2)); 
    return false;
  }
  
  console.log("passed variant j check: %s% > %f% (%d + %d / %d)", (thisLevel * 100).toFixed(2), Math.floor(minVariants * 100), curVal.counts[1], curVal.counts[3], curVal.depth);
    
  // check for minimum co-occurrence metric
  if (!curVal.hasOwnProperty('metric') || Math.abs(curVal.metric) < minMetric) {
    console.warn("position (%d, %d) failed metric check; wanted abs(metric) > %f, got %s instead", i, j, minMetric, curVal.metric.toFixed(4));
    return false;
  }
  
  console.log("passed metric test: abs(%s) > %f", curVal.metric.toFixed(4), minMetric);
  
  return true;
};

// add a line to separate overview from detail
d3.select('#d3canvas')
  .append('line')
    .attr('x1', 0)
    .attr('y1', 165)
    .attr('x2', 1000)
    .attr('y2', 165)
    .attr('stroke', '#000')
    .attr('stroke-width', 1)
    .attr('shape-rendering', 'crispEdges');
    
var overview = d3.select("#d3canvas")
  .append('g')
    .attr('class', 'overview')
    .attr('transform', 'translate(30, 25)');
    
// add a tip div
var tip = d3.tip().attr('class', 'd3-tip').html(function(d) { return d.pos; });
overview.call(tip);
    
var detailView = d3.select("#d3canvas")
  .append('g')
    .attr('class', 'detail')
    .attr('transform', 'translate(30, 170)');
    
// define red/green linear gradients
var defs = d3.select('#d3canvas').append('defs');

var gradient = defs.append('linearGradient')
    .attr('id', 'varToModal')
    .attr('x1', '0%')
    .attr('y1', '0%')
    .attr('x2', '100%')
    .attr('y2', '0%')
    .attr('spreadMethod', 'pad');
    
gradient.append('stop')
  .attr('offset', '0%')
  .attr('stop-color', 'rgb(255,0,0)')
  .attr('stop-opacity', 1);

gradient.append('stop')
  .attr('offset', '100%')
  .attr('stop-color', 'rgb(0,255,0)')
  .attr('stop-opacity', 1);
  
gradient = defs.append('linearGradient')
    .attr('id', 'modalToVar')
    .attr('x1', '0%')
    .attr('y1', '0%')
    .attr('x2', '100%')
    .attr('y2', '0%')
    .attr('spreadMethod', 'pad');
    
gradient.append('stop')
  .attr('offset', '0%')
  .attr('stop-color', 'rgb(0,255,0)')
  .attr('stop-opacity', 1);

gradient.append('stop')
  .attr('offset', '100%')
  .attr('stop-color', 'rgb(255,0,0)')
  .attr('stop-opacity', 1);
      
var x = d3.scale.ordinal()
  .rangeBands([0, 940], 0.1);
  
var y = d3.scale.ordinal()  // only show two entries
  .range([50,350]);
y.rangeBand = function() { return 200; }; // hack to keep d3 paradigm
  
var miniBarY = d3.scale.ordinal()
  .domain(['depth', 'variant', 'metric'])
  .rangeBands([0,100], 0.1);
  
var miniBarHeight = 100;
  
var depthScale = d3.scale.quantize()
  .range(colorbrewer.Greens[7])
  
var variantScale = d3.scale.quantize()
  .domain([0, 1])
  .range(colorbrewer.Reds[7]);
  
var metricScale = d3.scale.quantize()
  .domain([0, 1])
  .range(colorbrewer.Purples[7]);
  
var metricColorScale = d3.scale.quantize()
  .range(Array.prototype.slice.call(colorbrewer.RdBu[9]).reverse());


var makeSlider = function(type) {
  var colors, sliderX, displayFunc, startVal, dataDomain;
  
  switch (type) {
    case 'depth':
      colors = depthScale.range();
      startVal = 25;
      displayFunc = function(d) { return ">" + d + "%"; };
      sliderX = 150;
      dataDomain = [0, metrics.bounds.depth.max]; 
      break;
    case 'variant':
      colors = variantScale.range();
      startVal = 10;
      displayFunc = function(d) { return ">" + d + "%"; };
      sliderX = 450;
      dataDomain = [0, 1];
      break;
    case 'metric':
      colors = metricScale.range();
      startVal = 30;
      displayFunc = function(d) { return "> |" + (d / 100).toFixed(1) + "|"; };
      sliderX = 750;
      dataDomain = [0, 1];
      break;
    default:
      console.error('got unknown type for slider');
      return;
  }
  
  var xScale = d3.scale.linear().domain([0, 100]).range([0, 100]).clamp(true);
  var brush = d3.svg.brush()
    .x(xScale)
    .extent([0,0])
    .on('brush', brushed);
    
  // select the sliders group; create if it doesn't exist
  var sliders = d3.select("#d3canvas").selectAll('g.sliders').data([0]);
  sliders.enter()
    .append('g')
      .attr('transform', 'translate(30,800)')
      .attr('class', 'sliders');
    
  var sliderParent = sliders.append('g')
    .attr('class', type + '-slider')
    .attr('transform', 'translate(' + sliderX + ',0)');
    
  var sliderGroup = sliderParent.append('g')
    .attr('class', 'x axis')
    .attr('transform', 'translate(0, 50)')
    .call(d3.svg.axis()
      .scale(xScale)
      .orient('bottom')
      .tickFormat(displayFunc)
      .ticks(3)
      .tickSize(0)
      .tickPadding(12));
      
  sliderGroup.append('g')
    .attr('class', 'legend')
    .attr('transform', 'translate(0,-5)')
    .selectAll('rect')
      .data(colors)
      .enter()
        .append('rect')
          .attr('x', function(d,i) { return i * 100 / 7; })
          .attr('y', 0)
          .attr('width', 100 / 7)
          .attr('height', 10)
          .style('fill', function(d) { return d; });
      
  var slider = sliderParent.append('g')
    .attr('class', 'slider')
    .call(brush);
    
  slider.selectAll('.extent,.resize').remove();
  slider.select('.background').attr('height', 20).attr('transform', 'translate(0,40)');

  var handle = slider.append('circle')
    .attr('class', 'handle')
    .attr('transform', 'translate(0,50)')
    .attr('r', 9);
    
  slider.call(brush.event).call(brush.extent([startVal,startVal])).call(brush.event);
  
  // do bars now
  var barX = d3.scale.linear().domain(dataDomain).range([0, 100]);
  var barGroup = sliderParent.append('g')
    .attr('class', 'legend-bars');
    
  var barData = d3.layout.histogram()
    .bins(barX.ticks(10))
    (threshCounts[type]);
  
  var barY = d3.scale.linear()
    .domain([0, d3.max(barData, function(d) { return d.y; })])
    .range([50, 0]);
    
  var bar = barGroup.selectAll('.bar')
    .data(barData)
      .enter().append('g')
        .attr('class', 'bar')
        .attr('transform', function(d) {
          return 'translate(' + barX(d.x) + ',' + barY(d.y) + ')';
        });
        
  bar.append('rect')
    .attr('x', 1)
    .attr('width', barX(barData[0].dx) - 1)
    .attr('height', function(d) {
      return 50 - y(d.y);
    });
  
  
  function brushed() {
    var val = brush.extent()[0];
    if (d3.event.sourceEvent) {  // e.g. not a programmatic event
      val = xScale.invert(d3.mouse(this)[0]);
      brush.extent([val, val]);
    }
    
    handle.attr('cx', xScale(val));
    window.alert('got value from ' + type + ': ' + val);
  };
};

var detailScales = {};
var detailData = [];    

var updateVis = function() { 
  // do the brain-dead thing and just wipe everything
  overview.selectAll('g.ipos').remove();
  
  // set domains that depend on bounds of data
  metricColorScale.domain([
    metrics.bounds.metric.min, 
    metrics.bounds.metric.max
  ]);
  depthScale.domain([metrics.bounds.depth.min, metrics.bounds.depth.max]);

  // assume that filtered is populated here
  var ipos = overview.selectAll('g.ipos')
    .data(filtered, function(d) { return d.pos });
    
  // set the x domain
  x.domain(filtered.map(function(d) { return d.pos; }));
    
  // ENTER STEP
  var newPos = ipos.enter()
    .append('g')
      .attr('class', 'ipos')
      .attr('transform', function(d) { 
        return 'translate(' + x(d.pos) + ',0)';
      })
      .on('click', function(datum, i) {
        detailData = filtered[i].relatedPairs;
        updateDetail();
      })
      .on('mouseover', tip.show)
      .on('mouseout', tip.hide);
      
  var barHeight = 20;
  
  newPos.append('rect')
    .attr('class', 'depth')
    .attr('x', 0)
    .attr('y', miniBarY('depth'))
    .attr('height', miniBarY.rangeBand())
    .attr('width', x.rangeBand())
    .style('fill', function(d) {
      return depthScale(d3.max(d.relatedPairs, function(e) { return e.depth; }));
    });
    
  newPos.append('rect')
    .attr('class', 'variant')
    .attr('x', 0)
    .attr('y', miniBarY('variant'))
    .attr('height', miniBarY.rangeBand())
    .attr('width', x.rangeBand())
    .style('fill', function(d) {
      var imax = d3.max(d.relatedPairs, function(e) {
        return (e.counts[2] + e.counts[3]) / e.depth;
      });
      
      var jmax = d3.max(d.relatedPairs, function(e) {
        return (e.counts[1] + e.counts[3]) / e.depth;
      });
      
      return variantScale(Math.max(imax, jmax));
    });
    
  newPos.append('rect')
    .attr('class', 'metric')
    .attr('x', 0)
    .attr('y', miniBarY('metric'))
    .attr('height', miniBarY.rangeBand())
    .attr('width', x.rangeBand())
    .style('fill', function(d) {
      return metricScale(
        d3.max(d.relatedPairs, function(e) { 
          return Math.abs(e.metric); 
        })
      );
    });
    
  newPos.append('text')
    .attr('class', 'labelpos')
    .attr('x', x.rangeBand() / 2)
    .attr('y', miniBarHeight + 15)
    .text(function(d) { return d.pos; });
  
  // ENTER + UPDATE STEP
  
  
  // EXIT STEP
  
  hideLoading();
};

// type is one of {'metric', 'depth', 'variants'}
var makeColorRamp = function(type, parent, i, label, width, height) {
  width = width || 63;
  height = height || 6;
  
  var calcVar;
  var scale;
  switch (type) {
    case 'metric':
      scale = metricColorScale;
      break;
    case 'depth':
      scale = depthScale;
      break;
    case 'vari':
      scale = variantScale;
      calcVar = function(d) {
        return (d.counts[2] + d.counts[3]) / d.depth;
      };
      break;
    case 'varj':
      scale = variantScale;
      calcVar = function(d) {
        return (d.counts[1] + d.counts[3]) / d.depth;
      };
      break;
    default:
      console.warn("invalid color ramp selection made: %s", type);
      return;
  }
  
  var domain = scale.domain();
  var colors = scale.range();
  
  var ramp = parent.append('g')
    .attr('class', 'ramp')
    .attr('transform', 'translate(0,' + (i * 35) + ')');
    
  var rampX = d3.scale.ordinal().domain(colors).rangeRoundBands([0, width]);
    
  colors.forEach(function(d, i) {
    ramp.append('rect')
      .attr('x', rampX.rangeBand() * i)
      .attr('y', 0)
      .attr('height', height)
      .attr('width', rampX.rangeBand())
      .style('fill', d);
  });
  
  var indiScale = d3.scale.linear().domain(domain).range([rampX(colors[0]), rampX(colors[colors.length-1]) + rampX.rangeBand()]);
  
  ramp.append('path')
    .attr('d', function(d) {
      var startPt = calcVar ? indiScale(calcVar(d)) : indiScale(d[type]);
      return 'M ' + startPt + ' ' + (height + 2) + ' l 5 5 l -10 0 l 5 -5';
    })
    .style('fill', '#000');
    
  ramp.append('rect')
    .attr('x', function(d) {
      if (calcVar)
        return indiScale(calcVar(d)) - 7;
      else
        return indiScale(d[type]) - 7; 
    })
    .attr('y', height + 7)
    .attr('width', 15)
    .attr('height', 15)
    .style('fill', function(d) {
      if (calcVar) 
        return scale(calcVar(d));
      else
        return scale(d[type]);
    });
    
  ramp.append('text')
    .attr('x', width + 13)
    .attr('y', 23)
    .text(label);
};

var curDetail = [];
var curPage = 0;

var detailWidth = 350;
var pageSize = 2; // number of detail items to show per page
var updateDetail = function(page) {
  page = page || 0;
  if (page > (detailData.length / pageSize) - 1)
    page = Math.ceil(detailData.length / pageSize) - 1;
  if (page < 0)
    page = 0;

  curDetail = detailData.slice(page * pageSize, page * pageSize + pageSize);

  var jpos = detailView.selectAll('g.jpos')
    .data(curDetail, function(d) { return d.posi + "," + d.posj }); 
    
  // handle pagination of detail views (and remove old div)
  d3.selectAll('g.pagin').remove();
  var newPagin = detailView.append('g')
    .attr('class', 'pagin')
    .attr('transform', 'translate(0,20)');
    
  newPagin.append('text')
    .text(function() {
      var numFound = detailData.length;
      var plurality = numFound == 1 ? " correspondence" : " correspondences";
      
      return "Found " + numFound + plurality + " for " + curDetail[0].posi;
    });
    
  newPagin.append('text')
    .attr('x', 0)
    .attr('y', 15)
    .text("Showing "+(page*pageSize+1)+"-"+(page*pageSize+curDetail.length)+" of "+detailData.length);
    
  newPagin.append('text')
    .attr('class', function() { 
      return page <= 0 ? 'link' : 'link linkactive'; 
    })
    .attr('x', 0)
    .attr('y', 37)
    .style('fill', function() {
      if (page <= 0) return '#000';
      else return '#00f'; 
    })
    .text("<< Prev page")
    .on('click', function() { updateDetail(page - 1); });
    
  newPagin.append('text')
    .attr('class', function() { 
      return (page >= Math.ceil(detailData.length / pageSize) - 1) ? 
        'link' : 'link linkactive';
    })
    .attr('x', 85)
    .attr('y', 37)
    .style('fill', function() {
      if (page >= Math.ceil(detailData.length / pageSize) - 1) 
        return '#000';
      else 
        return '#00f';
    })
    .text('Next page >>')
    .on('click', function() { updateDetail(page + 1); });
    
  var sm = newPagin.append('g')
    .attr('class', 'sm')
    .attr('transform', 'translate(0,60)');
    
  var multiples = sm.selectAll('g.multiple')
    .data(detailData, function(d) { return d.posi + "," + d.posj; }).enter()
    .append('g')
      .attr('class', 'multiple')
      .attr('transform', function(d, i) {
        var x = (i % 3) * 90;
        var y = Math.floor(i / 3) * 90;
        
        return "translate(" + x + "," + y + ")";
      })
      .on('click', function(d, i) {
        // bring that page into view
        var reqPage = Math.floor(i / pageSize);
        updateDetail(reqPage);
      });
    
  drawCorrelationDiagram(multiples, 70, 60, 0.05);
    
  // set the domain for the y-scale
  y.domain(curDetail.map(function(d) { return d.posj; }));
    
  // ENTER STEP
  var newJpos = jpos.enter()
    .append('g')
      .attr('class', 'jpos')
      .attr('transform', function(d) {
        return 'translate(' + ((940 / 2) - (detailWidth / 2)) + ',' + y(d.posj) + ')';
      });
  
  // display some detailed data explicitly (e.g. thresholded metrics)
  var newDetail = newJpos.append('g')
    .attr('class', 'detail')
    .attr('transform',
      'translate(' + (detailWidth + 10) + "," + Math.floor(y.rangeBand() * 0.1) + ")"
    );
    
  makeColorRamp('metric', newDetail, 0,
    function(d) { 
      return d.metric.toFixed(3) + ": correlation between " + d.posi + " and " + d.posj;
    });
    
  makeColorRamp('depth', newDetail, 1,
    function(d) {
      return (d.depth / metrics['bounds']['depth']['max'] * 100).toFixed(2) + "% of max depth";
    });
    
  makeColorRamp('vari', newDetail, 2,
    function(d) {
      return "Variants at " + d.posi + ": " + ((d.counts[2] + d.counts[3]) / d.depth * 100).toFixed(1) + "%"; 
    });
    
  makeColorRamp('varj', newDetail, 3,
    function(d) {
      return "Variants at " + d.posj + ": " + ((d.counts[1] + d.counts[3]) / d.depth * 100).toFixed(1) + "%";
    });
    
  // handle making the correlation curves
  var cor = newJpos.append('g')
    .attr('class', 'correlation')
    .attr('width', '300');
  
  // finally, draw the correlation diagram
  drawCorrelationDiagram(cor, 300, 200, 0.1);
  
  
  // EXIT STEP
  jpos.exit()
    .transition()
      .duration(500)
      .attr('y', 70)
      .style('fill-opacity', 1e-6)
      .remove();
};

// given an element to add to (assumes parent has data selected and is in .enter()),
// and a bounding box of width and height, creates the correlation diagram
var drawCorrelationDiagram = function(parentGrp, width, height, percentRectWidth) {
  width = width || 350;
  height = height || y.rangeBand();
  percentRectWidth = percentRectWidth || 0.1;

  // initialize the detail scales and 
  // draw two blocks
  var s = function(curData, counts) { 
    return detailScales[curData.posi + "," + curData.posj](counts);
  };
  
  var w = function(curData, isVar, isI) {
    var c = isI ? 
      metrics[curData.posi][curData.posi].counts : 
      metrics[curData.posj][curData.posj].counts;
    
    return isVar ? c[3] : c[0];
  };

  // some helper functions
  var vi = function(curData) { return curData.counts[2] + curData.counts[3]; };
  var mi = function(curData) { return curData.counts[0] + curData.counts[1]; };
  var vj = function(curData) { return curData.counts[1] + curData.counts[3]; };
  var mj = function(curData) { return curData.counts[0] + curData.counts[2]; };

  var avi = function(curData) { return metrics[curData.posi][curData.posi].counts[3]; };
  var ami = function(curData) { return metrics[curData.posi][curData.posi].counts[0]; };
  var avj = function(curData) { return metrics[curData.posj][curData.posj].counts[3]; };
  var amj = function(curData) { return metrics[curData.posj][curData.posj].counts[0]; };

  var vivj = function(curData) { return curData.counts[3]; };
  var vimj = function(curData) { return curData.counts[2]; };
  var mivj = function(curData) { return curData.counts[1]; };
  var mimj = function(curData) { return curData.counts[0]; };

  
  // add in the paths now
  // var i to var j
  
  // the size of the gap between classes of reads
  var gap = height * 0.125;
  
  var overlap = 2;
  var rectW = width * percentRectWidth + overlap;
  var areaW = width - 2 * (width * percentRectWidth);
  
  parentGrp.append('rect')
    .attr('x', 0)
    .attr('y', 0)
    .attr('height', function(d) {
      var maxDepth = Math.max(
        metrics[d.posi][d.posi].depth,
        metrics[d.posj][d.posj].depth
      );
    
      detailScales[d.posi + "," + d.posj] = d3.scale.linear()
        .domain([0, maxDepth])
        .range([0, height - gap]);
        
      return s(d, avj(d));
    })
    .attr('width', rectW)
    .style('fill', '#f00');
    
  parentGrp.append('rect')
    .attr('x', 0)
    .attr('y', function(d) {
      return s(d, avj(d)) + gap;
    })
    .attr('height', function(d) {
      return s(d, amj(d));
    })
    .attr('width', rectW)
    .style('fill', '#0f0');
    
  parentGrp.append('rect')
    .attr('x', width - rectW)
    .attr('y', 0)
    .attr('height', function(d) {
      return s(d, avi(d));
    })
    .attr('width', rectW)
    .style('fill', '#f00');
    
  parentGrp.append('rect')
    .attr('x', width - rectW)
    .attr('y', function(d) {
      return s(d, avi(d)) + gap;
    })
    .attr('height', function(d) {
      return s(d, ami(d));
    })
    .attr('width', rectW)
    .style('fill', '#0f0');
    
  // append position labels
  parentGrp.append('text')
    .attr('class', 'poslabel')
    .attr('x', Math.floor(rectW / 2))
    .attr('y', height + 20)
    .text(function(d) { return d.posj; });  
    
  parentGrp.append('text')
    .attr('class', 'poslabel')
    .attr('x', width - Math.ceil(rectW / 2))
    .attr('y', height + 20)
    .text(function(d) { return d.posi; });

  // path-specific coordinates
  var leftX = rectW - overlap;
  var rightX = width - (rectW - overlap);
    
  // handle var_i excess
  var exitAngle = Math.PI / 4;
  var len = areaW * 0.15;
  var calcLeaving = function(d, type) {
    var xDir, yDir, n, start;
    switch (type) {
      case "vi":
        xDir = -1; yDir = -1;
        n = avi(d) - vi(d);
        break;
      case "vj":
        xDir = 1; yDir = -1;
        n = avj(d) - vj(d);
        break;
      case "mi":
        xDir = -1; yDir = 1;
        n = ami(d) - mi(d);
        break;
      case "mj":
        xDir = 1; yDir = 1;
        n = amj(d) - mj(d);
    }
    
    var startX = xDir == 1 ? leftX : rightX;
    var startY = yDir == -1 ? 0 : 
      xDir == -1 ? s(d, ami(d) + avi(d)) + gap : s(d, amj(d) + avj(d)) + gap;
    
    var path = "M " + startX + " " + startY;
    path += " q " + (xDir * len) + " 0 " + (xDir * (len + len * Math.cos(exitAngle))) + " " + (yDir * len * Math.sin(exitAngle));
    
    path += " l " + (xDir * s(d,n) * Math.cos(Math.PI / 2 - exitAngle)) + " " + ((-yDir) * s(d,n) * Math.sin(Math.PI / 2 - exitAngle));
    
    var t = s(d,n) * Math.cos(Math.PI / 2 - exitAngle) + len + len * Math.cos(exitAngle);
    t = t / (1 + Math.cos(exitAngle));
    
    path += " q " + ((-xDir) * t * Math.cos(exitAngle)) + " " + ((-yDir) * t * Math.sin(exitAngle)) + " " + ((-xDir) * t * Math.cos(exitAngle) + (-xDir) * t) + " " + ((-yDir) * t * Math.sin(exitAngle));
    
    return path;          
  };
  
  // handle read exits (those reads that don't appear in the other position)
  parentGrp.append('path')
    .attr('d', function(d) {
      return calcLeaving(d, 'vi');
    })
    .style('fill', 'rgba(128,128,128,0.5)');
    
  parentGrp.append('path')
    .attr('d', function(d) { 
      return calcLeaving(d, 'mi');
    })
    .style('fill', 'rgba(128,128,128,0.5)');
    
  parentGrp.append('path')
    .attr('d', function(d) { 
      return calcLeaving(d, 'vj');
    })
    .style('fill', 'rgba(128,128,128,0.5)');
  
  parentGrp.append('path')
    .attr('d', function(d) { 
      return calcLeaving(d, 'mj');
    })
    .style('fill', 'rgba(128,128,128,0.5)');

  // handle var_i -> var_j
  parentGrp.append('path')
    .attr('d', function(d) {
      var mi = avi(d) - vi(d);
      var mj = avj(d) - vj(d);
      var n = vivj(d);

      var path = "M " + rightX + " " + s(d,mi) + " l -" + areaW + " " + s(d,mj-mi);
      path += " l 0 " + s(d,n);
      path += " l " + areaW + " " + -1 * s(d, mj-mi);
      path += " l 0 -" + s(d,n);

      return path;
    })
    .style('fill', 'rgb(255,0,0)');
    
  // handle var_i -> modal_j
  parentGrp.append('path')
    .attr('d', function(d) {
      var iy = avi(d) - vi(d) + vivj(d);
      var jy = avj(d);
      var n = vimj(d);
      
      var path = "M " + rightX + " " + s(d,iy) + " l -" + areaW + " " + (s(d,jy-iy) + gap);
      path += " l 0 " + s(d,n);
      path += " l " + areaW + " " + -1 * (s(d,jy-iy) + gap);
      path += " l 0 -" + s(d,n);
      
      return path;
    })
    .style('fill', 'url(#modalToVar)');
    
  // handle modal_i -> var_j
  parentGrp.append('path')
    .attr('d', function(d) {
      var n = mivj(d);
      var iy = avi(d) // + gap
      var jy = avj(d) - n;
      
      var path = "M " + rightX + " " + (s(d,iy) + gap);
      path += " L " + leftX + " " + s(d,jy);
      path += " l 0 " + s(d,n);
      path += " L " + rightX + " " + (s(d,iy+n) + gap);
      path += " l 0 -" + s(d,n);
      
      return path;
    })
    .style('fill', 'url(#varToModal)');
    
  // handle modal_i -> modal_j
  parentGrp.append('path')
    .attr('d', function(d) {
      var n = mimj(d);
      var iy = avi(d) + mivj(d); // + gap
      var jy = avj(d) + vimj(d); // + gap
      
      var path = "M " + rightX + " " + (s(d,iy) + gap);
      path += " L " + leftX + " " + (s(d,jy) + gap);
      path += " l 0 " + s(d,n);
      path += " L " + rightX + " " + (s(d,iy+n) + gap);
      path += " l 0 -" + s(d,n);
      return path;
    })
    .style('fill', 'rgb(0,255,0)');
};

var updateLoadingStatus = function(msg) {
  $("#d3loading").show();
  $("#status").html(msg);
};

var hideLoading = function() {
  $("#d3loading").hide();
  $("#status").html("");
};

$(document).ready(function() {
  var datasets;
  
  var ignoreHashChange = false;
  var checkHash = function() {
    if (ignoreHashChange === false) {
      // remove all data from the canvas
      d3.select("#d3canvas .overview").selectAll("*").remove();
      d3.select("#d3canvas .detail").selectAll("*").remove();
      metrics = {};
    
      var curDataset;
      if (window.location.hash) {
        curDataset = window.location.hash.substring(1);
      } else {
        if (Object.keys(datasets) == 0) {
          console.error("no datasets are defined, quitting...");
          return;
        }
        
        ignoreHashChange = true;
        curDataset = Object.keys(datasets)[4];
      }
      
      // update the current button text
      $("#currentDataset").html(curDataset);
      
      // actually load the dataset (matrixviewer.js)
      loadDataset(curDataset, datasets[curDataset]);
    }

    // if `ignoreHashChange` was true, set it to `false` for the next call
    ignoreHashChange = false;
  };
  
  window.addEventListener('hashchange', checkHash, false);
  
  $.getJSON("definedData.json", function(data, status) {
    datasets = data.datasets;
    $("#datasetOptions").html("")
    
    for (dataset in datasets) {
      $("#datasetOptions").append('<li><a href="#' + dataset + '">' + dataset + '</a></li>');
    }
    
    checkHash();
  });

  // set up sliders
  $("#threshold-depth").slider({
    tooltip: 'always',
    formatter: function(val) { 
      return ">" + val + "%";
    }
  });
  
  $("#threshold-variants").slider({
    tooltip: 'always',
    formatter: function(val) { 
      return ">" + val + "%";
    }
  });
  
  $("#threshold-metric").slider({
    tooltip: 'always',
    formatter: function(val) {
      return ">abs(" + val + ")";
    }
  });
  
  var refilter = function() {
    minDepthPercent = +$("#threshold-depth").val() / 100;
    minVariants = +$("#threshold-variants").val() / 100;
    minMetric = +$("#threshold-metric").val();
      
    filterData();
    updateVis();
  };
  
  $("#threshold-depth").on('slideStop', refilter);
  $("#threshold-variants").on('slideStop', refilter);
  $("#threshold-metric").on('slideStop', refilter);
  
  
  console.log("done");
  
  
  
});
