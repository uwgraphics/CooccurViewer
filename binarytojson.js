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
          var index_j = (i - 1) - Math.floor(ds.numWindow / 2) + j + 1;

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

var canvas = d3.select("#d3canvas")
  .append('g')
    .attr('transform', 'translate(30, 30)');
    
var x = d3.scale.ordinal()
  .rangeBands([0, 940], 0.1);
    
var updateVis = function() { 
  // do the brain-dead thing and just wipe everything
  canvas.selectAll('g.ipos').remove();

  // assume that filtered is populated here
  var ipos = canvas.selectAll('g.ipos')
    .data(filtered, function(d) { return d.pos });
    
    // set the x domain
    x.domain(filtered.map(function(d) { return d.pos; }));
    
  // ENTER STEP
  var newPos = ipos.enter()
    .append('g')
      .attr('class', 'ipos')
      .attr('transform', function(d) { 
        return 'translate(' + x(d.pos) + ',0)';
      });
      
  var barHeight = 20;
      
  newPos.append('rect')
    .attr('width', x.rangeBand())
    .attr('height', barHeight)
    .style('fill', '#f00');
    
  newPos.append('text')
    .attr('class', 'label')
    .attr('x', x.rangeBand() / 2)
    .attr('y', 0)
    .text(function(d) { return d.pos; });
  
  // ENTER + UPDATE STEP
  
  
  // EXIT STEP
  
  
};

$(document).ready(function() {
  makeBinaryFileRequest("data/VHA3_P1_F991_DPI3-ref/conjProbDiff.dat", "metric");
  makeBinaryFileRequest("data/VHA3_P1_F991_DPI3-ref/variantCounts.dat", "counts");
  makeBinaryFileRequest("data/VHA3_P1_F991_DPI3-ref/readBreadth.dat", "depth");
  
  console.log("done");
  
  // try to output a json file [doesn't work, json too big]
  // <http://stackoverflow.com/questions/22055598/writing-a-json-object-to-a-text-file-in-javascript>
  /*
  var url = 'data:text/json;charset=utf8,' + encodeURIComponent(JSON.stringify(metrics));
  console.log("finished");
  window.open(url, '_blank');
  window.focus();*/
  
  
});
