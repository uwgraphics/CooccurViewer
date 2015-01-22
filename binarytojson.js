var ready = false;

var ds = {
  numWindow: 0,
  numPos: 0
};

// JSON object to hold metrics for each pair of positions
var metrics = {};
var filtered = {};

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
  
  filterData();
  updateVis();
};
  
var filterData = function() {
  
  // try to filter out anything that doesn't meet the following criteria
  
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
      
      /*
      if (!filtered.hasOwnProperty(i))
        filtered[i] = {};
      
      filtered[i][j] = curVal;*/
    });
  });
  
  console.timeEnd("filtering");
};

var checkFilterEntry = function(i, j) {
  curVal = metrics[i][j];
  
  console.log("---- comparison pos %d to %d", +i, +j);
  
   // check for minimum depth; quit if fails
  var minDepth = Math.floor(metrics['bounds']['depth']['max'] * minDepthPercent);
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

var canvas = d3.select("#d3canvas")
  .append('g')
    .attr('transform', 'translate(30, 30)');
    
var overview = d3.select("#d3canvas")
  .append('g')
    .attr('class', 'overview')
    .attr('transform', 'translate(30, 30)');
    
var detailView = d3.select("#d3canvas")
  .append('g')
    .attr('class', 'detail')
    .attr('transform', 'translate(30, 150)');
    
// define red/green linear gradients
var gradient = d3.select('#d3canvas').append('defs')
  .append('linearGradient')
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
  
gradient = d3.select('#d3canvas').append('defs')
  .append('linearGradient')
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
  
var y = d3.scale.ordinal()
  .rangeBands([0, 620], 0.1);
  
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
  .range(colorbrewer.RdBu[9]);

var detailScales = {};
    
var updateVis = function() { 
  // do the brain-dead thing and just wipe everything
  overview.selectAll('g.ipos').remove();
  
  // set domains that depend on bounds of data
  metricColorScale.domain([
    metrics.bounds.metric.max, 
    metrics.bounds.metric.min
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
        var jpos = detailView.selectAll('g.jpos')
          .data(filtered[i].relatedPairs, function(d) { return d.posi + "," + d.posj }); 
          
        y.domain(filtered[i].relatedPairs.map(function(d) { return d.posj; }));
          
        // ENTER STEP
        var newJpos = jpos.enter()
          .append('g')
            .attr('class', 'jpos')
            .attr('transform', function(d) {
              return 'translate(' + x(datum.pos) + ',' + y(d.posj) + ')';
            });
            
        newJpos.append('rect')
          .attr('height', y.rangeBand())
          .attr('width', x.rangeBand())
          .attr('x', 0)
          .attr('y', 0)
          .style('fill', function(d) { return metricColorScale(d.metric); })
          .on('click', function(d) {
            checkFilterEntry(d.posi, d.posj);
          });
          
        var newDetail = newJpos.append('g')
          .attr('class', 'detail')
          .attr('transform',
            'translate(' + (x.rangeBand() + 3) + "," + (y.rangeBand() / 2 - 30) + ')'
          );
          
        newDetail.append('text')
          .text(function(d) { return "Position: " + d.posi + ", " + d.posj; });
          
        newDetail.append('text')
          .attr('y', 15)
          .text(function(d) {
            var varPer = (d.counts[2] + d.counts[3]) / d.depth * 100;
            return "Variant % at " + d.posi + ": " + varPer.toFixed(2) + "%";
          });
          
        newDetail.append('text')
          .attr('y', 30)
          .text(function(d) {
            var varPer = (d.counts[1] + d.counts[3]) / d.depth * 100;
            return "Variant % at " + d.posj + ": " + varPer.toFixed(2) + "%";
          });
          
        newDetail.append('text')
          .attr('y', 45)
          .text(function(d) {
            return d.depth + " reads span these two locations";
          });
          
        newDetail.append('text')
          .attr('y', 60)
          .text(function(d) {
            return "Metric: " + d.metric.toFixed(3);
          });
          
        // handle making the correlation curves
        var cor = newJpos.append('g')
          .attr('class', 'correlation')
          .attr('transform', 'translate(-300, 0)')
          .attr('width', '300');
       
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
        var gap = 25;
        
        cor.append('rect')
          .attr('x', 0)
          .attr('y', 0)
          .attr('height', function(d) {
            var maxDepth = Math.max(
              metrics[d.posi][d.posi].depth,
              metrics[d.posj][d.posj].depth
            );
          
            detailScales[d.posi + "," + d.posj] = d3.scale.linear()
              .domain([0, maxDepth])
              .range([0, y.rangeBand() - gap]);
              
            return s(d, avj(d));
          })
          .attr('width', 12)
          .style('fill', '#f00');
          
        cor.append('rect')
          .attr('x', 0)
          .attr('y', function(d) {
            return s(d, avj(d)) + gap;
          })
          .attr('height', function(d) {
            return s(d, amj(d));
          })
          .attr('width', 12)
          .style('fill', '#0f0');
        

        cor.append('rect')
          .attr('x', 288)
          .attr('y', 0)
          .attr('height', function(d) {
            return s(d, avi(d));
          })
          .attr('width', 12)
          .style('fill', '#f00');
          
        cor.append('rect')
          .attr('x', 288)
          .attr('y', function(d) {
            return s(d, avi(d)) + gap;
          })
          .attr('height', function(d) {
            return s(d, ami(d));
          })
          .attr('width', 12)
          .style('fill', '#0f0');

        // handle var_i excess
        var exitAngle = Math.PI / 4;
        var len = 50;
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
          
          var startX = xDir == 1 ? 10 : 290;
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
        cor.append('path')
          .attr('d', function(d) {
            return calcLeaving(d, 'vi');
          })
          .style('fill', 'rgba(128,128,128,0.5)');
          
        cor.append('path')
          .attr('d', function(d) { 
            return calcLeaving(d, 'mi');
          })
          .style('fill', 'rgba(128,128,128,0.5)');
          
        cor.append('path')
          .attr('d', function(d) { 
            return calcLeaving(d, 'vj');
          })
          .style('fill', 'rgba(128,128,128,0.5)');
        
        cor.append('path')
          .attr('d', function(d) { 
            return calcLeaving(d, 'mj');
          })
          .style('fill', 'rgba(128,128,128,0.5)');

        // handle var_i -> var_j
        cor.append('path')
          .attr('d', function(d) {
            var mi = avi(d) - vi(d);
            var mj = avj(d) - vj(d);
            var n = vivj(d);

            var path = "M 290 " + s(d,mi) + " l -280 " + s(d,mj-mi);
            path += " l 0 " + s(d,n);
            path += " l 280 " + -1 * s(d, mj-mi);
            path += " l 0 -" + s(d,n);

            return path;
          })
          .style('fill', 'rgb(255,0,0)');
          
        // handle var_i -> modal_j
        cor.append('path')
          .attr('d', function(d) {
            var iy = avi(d) - vi(d) + vivj(d);
            var jy = avj(d);
            var n = vimj(d);
            
            var path = "M 290 " + s(d,iy) + " l -280 " + (s(d,jy-iy) + gap);
            path += " l 0 " + s(d,n);
            path += " l 280 " + -1 * (s(d,jy-iy) + gap);
            path += " l 0 -" + s(d,n);
            
            return path;
          })
          .style('fill', 'url(#modalToVar)');
          
        // handle modal_i -> var_j
        cor.append('path')
          .attr('d', function(d) {
            var n = mivj(d);
            var iy = avi(d) // + gap
            var jy = avj(d) - n;
            
            var path = "M 290 " + (s(d,iy) + gap);
            path += " L 10 " + s(d,jy);
            path += " l 0 " + s(d,n);
            path += " L 290 " + (s(d,iy+n) + gap);
            path += " l 0 -" + s(d,n);
            
            return path;
          })
          .style('fill', 'url(#varToModal)');
          
        // handle modal_i -> modal_j
        cor.append('path')
          .attr('d', function(d) {
            var n = mimj(d);
            var iy = avi(d) + mivj(d); // + gap
            var jy = avj(d) + vimj(d); // + gap
            
            var path = "M 290 " + (s(d,iy) + gap);
            path += " L 10 " + (s(d,jy) + gap);
            path += " l 0 " + s(d,n);
            path += " L 290 " + (s(d,iy+n) + gap);
            path += " l 0 -" + s(d,n);
            return path;
          })
          .style('fill', 'rgb(0,255,0)');
          
        // EXIT STEP
        jpos.exit()
          .transition()
            .duration(500)
            .attr('y', 70)
            .style('fill-opacity', 1e-6)
            .remove();
      });
      
  var barHeight = 20;
      
  /*
  newPos.append('rect')
    .attr('width', x.rangeBand())
    .attr('height', barHeight)
    .style('fill', '#f00');*/
  
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
  
  
};

$(document).ready(function() {
  makeBinaryFileRequest("data/VHA3_P1_F991_DPI3-ref/conjProbDiff.dat", "metric");
  makeBinaryFileRequest("data/VHA3_P1_F991_DPI3-ref/variantCounts.dat", "counts");
  makeBinaryFileRequest("data/VHA3_P1_F991_DPI3-ref/readBreadth.dat", "depth");

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
  
  // try to output a json file [doesn't work, json too big]
  // <http://stackoverflow.com/questions/22055598/writing-a-json-object-to-a-text-file-in-javascript>
  /*
  var url = 'data:text/json;charset=utf8,' + encodeURIComponent(JSON.stringify(metrics));
  console.log("finished");
  window.open(url, '_blank');
  window.focus();*/
  
  
});
