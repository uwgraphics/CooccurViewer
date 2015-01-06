var ready = false;

var ds = {
  numWindow: 0,
  numPos: 0
};

// JSON object to hold metrics for each pair of positions
var metrics = {};

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
  console.log("starting...");

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

  metrics['bounds'][name] = {max: -1000000, min: 1000000};

  // explode out the sparse representation to a full representation for the GPU
  var offset = headerSize;
  if (isSparse) {
    for (var n = 0; n < expectedPositions; n++) {
      var curIndex = dv.getInt32(offset);
      offset += 4;

      // okay, so we have the index. convert into i, j coordinates
      var i = Math.floor(curIndex / ds.numWindow);
      var j = i - Math.floor(ds.numWindow / 2) + (curIndex % ds.numWindow);

      // create an entry for i if it doesn't exist
      if (!metrics.hasOwnProperty(i))
        metrics[i] = {};

      // create an entry for i > j if it doesn't exist
      if (!metrics[i].hasOwnProperty(j))
        metrics[i][j] = {};

      // fill in the metric
      var curVal = getDataVal(offset);
      metrics[i][j][name] = curVal;

      // calculate bounds
      metrics['bounds'][name]['max'] = Math.max(metrics['bounds'][name]['max'], curVal);
      metrics['bounds'][name]['min'] = Math.min(metrics['bounds'][name]['min'], curVal);

      // increment the offset counter
      offset += precision;
    }
  } else {
	for (var i = 0; i < numPositions; i++) {
      for (var j = windowOffset; j < ds.numWindow - windowOffset; j++) {
        for(var n = 0; n < thisSpacing; n++) {
          var curVal = getDataVal(offset);

          // increment the offset counter
          offset += precision;

		  // if this number is zero, don't bother recording it
		  if (curVal == 0)
			continue;

		  // calculate these indicies
		  var index_i = i;
		  var index_j = i - Math.floor(ds.numWindow / 2) + j;

		  // create an entry for i if it doesn't exist
		  if (!metrics.hasOwnProperty(index_i))
			metrics[index_i] = {};

		  // create an entry for i > j if it doesn't exist
		  if (!metrics[index_i].hasOwnProperty(index_j))
			metrics[index_i][index_j] = {};

		  // fill in the metric
		  metrics[index_i][index_j][name] = curVal;

		  // calculate bounds
		  metrics['bounds'][name]['max'] = Math.max(metrics['bounds'][name]['max'], curVal);
		  metrics['bounds'][name]['min'] = Math.min(metrics['bounds'][name]['min'], curVal);
        }
      }
    }
  }

  console.timeEnd("parsing file " + name);
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
