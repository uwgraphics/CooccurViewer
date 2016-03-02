var ready = false;

var ds = {
  numWindow: 0,
  numPos: 0
};

// JSON object to hold metrics for each pair of positions
var metrics = {};
var filtered = {};
var refString = "-";

// keep track of any annotations we have
var annotations = [];

// the position-ordered sequence of annotations 
// (e.g. break an annotation up if it spans multiple sequences of positions)
var annotatePos = [];

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

var doHistograms = false;

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

  console.log("trying to parse file %s", name)
  console.time("parsing file " + name);
  //updateLoadingStatus("parsing " + name + " file...");

  var dv = new DataView(data);
  console.log("%s has size %d (%s MB)", name, dv.byteLength, (dv.byteLength / 1024 / 1024).toFixed(1));

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
    console.warn("number of lines in file %s does not match data: expected %d, depth had %d lines", name, ds.numPos, thisNumPos);
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
    $("#numWindow").html(Math.floor(ds.numWindow / 2));
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
  
  var createPairIfMissing = function(i, j) {
    // create an entry for i if it doesn't exist
    if (!metrics.hasOwnProperty(i))
      metrics[i] = {};

    // create an entry for i > j if it doesn't exist
    if (!metrics[i].hasOwnProperty(j)) {
      metrics[i][j] = {};
      metrics[i][j]["posi"] = +i;
      metrics[i][j]["posj"] = +j;
    }
  };

  // explode out the sparse representation to a full representation for the GPU
  var offset = headerSize;
  if (isSparse) {
    console.log(name + " is sparse...");
    
    // handle the special fullcounts file 
    // (which contains a sparse 4x4 matrix of bases for every co-occurrence)
    if (name == "fullcounts") {
      
      var bases = ['A', 'T', 'C', 'G'];
      var getBasesFromByte = function(byte) {
        var bi = bases[byte >> 2];
        var bj = bases[byte & 3];
        return bi + "," + bj;
      };
        
      var counter = 0;
      while (dv.byteLength != offset) {
        if (++counter % 10000 === 0) {
          console.log("fullcounts checkpoint (%s% done)", (offset / dv.byteLength * 100).toFixed(2));
        }
        
        var curIndex = dv.getInt32(offset);
        offset += 4;
        
        // okay, so we have the index (0-indexed); convert into i, j coordinates (1-index)
        var i = Math.floor(curIndex / ds.numWindow) + 1;
        var j = (i - 1) - Math.floor(ds.numWindow / 2) + (curIndex % ds.numWindow) + 1;
        
        var numEntries = dv.getInt8(offset);
        offset += 1;
        
        if (numEntries == 0)
          continue;
        
        createPairIfMissing(i, j);
        metrics[i][j][name] = [];
        
        for (var n = 0; n < numEntries; n++) {
          var baseByte = dv.getInt8(offset);
          offset += 1;
          
          var base = getBasesFromByte(baseByte);
          
          var newEntry = {};
          newEntry['base'] = base;
          newEntry['num'] = dv.getInt32(offset);
          offset += 4;
          
          metrics[i][j][name].push(newEntry);
        }
      }
    } else if (name == "refdata") {
      refString = "-";
      while (dv.byteLength != offset) {
        var thisByte = dv.getInt8(offset);
        offset += 1;
        
        // TODO: positions that don't have a reference will default to A (bad?)
        var bases = ['A', 'T', 'C', 'G'];
        
        var theseBases = "";
        for (var n = 0; n < 4; n++) {
          var thisBase = bases[thisByte & 3];
          theseBases = thisBase + theseBases;
          thisByte >>= 2;
        }
        
        refString += theseBases;        
      }
    } else {      
      for (var n = 0; n < expectedPositions; n++) {
        var curIndex = dv.getInt32(offset);
        offset += 4;

        // okay, so we have the index (0-indexed); convert into i, j coordinates (1-index)
        var i = Math.floor(curIndex / ds.numWindow) + 1;
        var j = (i - 1) - Math.floor(ds.numWindow / 2) + (curIndex % ds.numWindow) + 1;

        // create an entry for i, j if it doesn't exist
        createPairIfMissing(i, j);

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
          createPairIfMissing(index_i, index_j);
          
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

var updateProgress = function(name) {
  return function(e) {
    if (e.lengthComputable) {
      var val = Math.round(e.loaded / e.total * 100);
      $("#" + name + "Prog").val(val);
      $("#" + name + "ProgVal").html(val + "%");
    } else {
      $("#" + name + "Prog").val();
      $("#" + name + "ProgVal").html("N/A");
    }
  };
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

  xhr.addEventListener('progress', updateProgress(name), false);
  
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

var brushes = {};
var firstRun = true;
var continueIfDone = function() {
  
  var theIs = Object.keys(metrics);
  
  if (theIs.length == 0)
    return;
  
  // spin until all files have been parsed
  var counter = 10;
  while (--counter > 0) {
    // get an arbitrary index to play with
    var i = theIs[Math.floor(Math.random() * theIs.length)];
  
    var theJs = Object.keys(metrics[i]);
    var j = theJs[Math.floor(Math.random() * theJs.length)];
    
    var curVal = metrics[i][j];
  
    if (!curVal.hasOwnProperty('depth')) {
      console.log("failed to find 'depth' (%s, %s), waiting...", i, j);
      return;
    }
      
    if (!curVal.hasOwnProperty('fullcounts')) {
      console.log("failed to find fullcounts");
      return;
    }
    
    
    // metric should only be missing if no variants at either position (assume metric isn't loaded yet)
    if (!curVal.hasOwnProperty('metric')) {  
      console.log("failed to find a metric when one was expected, waiting...");
      console.log(curVal);
      continue;
    }
  }
  
  // set a visibility field
  Object.keys(metrics).forEach(function(curI) {
    Object.keys(metrics[curI]).forEach(function(curJ) {
      metrics[curI][curJ]['visible'] = false;
    });
  });
  
  updateLoadingStatus("collecting data...");
  
  // try doing the scales
  if (doHistograms) {
    collectStats();
    tryCollectStats();
  } 
  
  makeSlider('depth');
  makeSlider('variant');
  makeSlider('metric');
  
  firstRun = false;
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
      
      var thisCounts = getVariantMatrixAtPos(curPair.posi, curPair.posj);
      if (curPair.hasOwnProperty('counts')) {
        threshCounts.variant.push(
          Math.min(
            (thisCounts.vivj + thisCounts.vimj) / curPair.depth,
            (thisCounts.vivj + thisCounts.mivj) / curPair.depth
          )
        );
      }
      
      if (curPair.hasOwnProperty('metric'))
        threshCounts.metric.push(Math.abs(curPair.metric));
    });
  });
  
  console.timeEnd('collecting stats');
};  

var flatMetrics = [];
var tryCollectStats = function() {
  console.time('trying new filtering');

  flatMetrics = [];
  
  d3.keys(metrics).forEach(function(curI) {
    d3.keys(metrics[curI]).forEach(function(curJ) {
      // filter here
      var curVal = metrics[curI][curJ];
      if (!curVal.hasOwnProperty('depth') || !curVal.hasOwnProperty('counts') || !curVal.hasOwnProperty('metric'))
        return;
        
      var minDepth = Math.floor(metrics['bounds']['depth']['max'] * minDepthPercent);
      if (curVal.depth < minDepth) {
        metrics[curI][curJ].visible = false;
        return;
      }
      
      var thisCounts = getVariantMatrixAtPos(curI, curJ);
      var varLevel = (thisCounts.vivj + thisCounts.vimj) / curVal.depth;
      if (varLevel < minVariants) {
        metrics[curI][curJ].visible = false;
        return;
      }
      
      varLevel = (thisCounts.vivj + thisCounts.mivj) / curVal.depth;
      if (varLevel < minVariants) {
        metrics[curI][curJ].visible = false;
        return;
      }
      
      if (Math.abs(curVal.metric) < minMetric) {
        metrics[curI][curJ].visible = false;
        return;
      }
      
      metrics[curI][curJ].visible = true;
      
      flatMetrics.push(metrics[curI][curJ]);
    });
  });
  
  console.timeEnd('trying new filtering');
};

var histoScales = {'x': {}, 'y': {}};
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
      // if (!curVal.hasOwnProperty('counts')) {
      //   console.log("missing counts from " + i + ", " + j);
      //   return;
      // }
      
      // calculate synonymy for those pairs that we care about (short-circuit if already calculated)
      getSynonymyCounts(curVal.posi, curVal.posj);
      // var thisReads = getVariantMatrixAtPos(i, j);
      
      var thisCounts = getVariantMatrixAtPos(i, j);
      var thisLevel = (thisCounts.vivj + thisCounts.vimj) / curVal.depth;
      if (thisLevel < minVariants)
        return;
        
      // do we enforce a minimum variance for j as well?
      thisLevel = (thisCounts.vivj + thisCounts.mivj) / curVal.depth;
      if (minVarJ && thisLevel < minVariants)
        return;
        
      // check for minimum co-occurrence metric
      if (Math.abs(!curVal.hasOwnProperty('metric') || $("#dosynonymy").prop('checked') ? curVal.metric_syn : curVal.metric) < minMetric)
        return;
        
      // curVal.posi = +i;
      // curVal.posj = +j;

      // calculate synonymy for those pairs that we care about (short-circuit if already calculated)
      // getSynonymyCounts(curVal.posi, curVal.posj);

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

binThresholds = {};
var updateHistograms = function() { 
  if (!doHistograms) return;
  
  // update the histograms
  tryCollectStats();
  
  ['metric', 'depth', 'variant'].forEach(function(type) {
    // collect the data for this histogram
    var typeVals = [];
    switch (type) {
      case 'metric':
      case 'depth':
        typeVals = flatMetrics.map(function(d) {
          return d[type];
        });
        break;
      case 'variant':
        typeVals = flatMetrics.map(function(d) {
          var thisCounts = getVariantMatrixAtPos(d.posi, d.posj);
          return Math.min(
            (thisCounts.vivj + thisCounts.vimj) / d.depth,
            (thisCounts.vivj + thisCounts.mivj) / d.depth
          );
        });
        break;
      default:
        console.error('unknown type received when redrawing selected histogram bars');
        return;
    }
    
    var selBarData = d3.layout.histogram()
      .bins(binThresholds[type])
      (typeVals);
  
    var selBar = d3.select('.' + type + '-slider').select('.legend-bars').selectAll('.barVisible')
      .data(selBarData);
      
    // ENTER  
    var newBar = selBar.enter()
      .append('g')
        .attr('class', 'barVisible')
        .attr('transform', function(d) {
          return 'translate(' + histoScales.x[type](d.x) + ',' + histoScales.y[type](d.y) + ')';
        });
            
    newBar.append('rect')
      .attr('x', 1)
      .attr('width', histoScales.x[type](selBarData[0].dx) - 1)
      .style('fill', '#f00');
      
    // ENTER + UPDATE
    selBar.attr('transform', function(d) {
      return 'translate(' + histoScales.x[type](d.x) + ',' + histoScales.y[type](d.y) + ')';
    });
    
    selBar.select('rect')
      .attr('width', histoScales.x[type](selBarData[0].dx) - 1) 
      .attr('height', function(d) {
        return 50 - histoScales.y[type](d.y);
      });
  });
};

var progressStatus = '<div class="progs">' +
  '<span id="depthStatus">Loading Depth</span>: ' +
  '<progress value="0" max="100" id="depthProg"></progress> ' +
  '<span class="progValue" id="depthProgVal">0%</span><br />' +
  '<span id="metricStatus">Loading Metric</span>: ' +
  '<progress value="0" max="100" id="metricProg"></progress> ' +
  '<span class="progValue" id="metricProgVal">0%</span><br />' +
  '<span id="fullcountsStatus">Loading Base Counts</span>: ' +
  '<progress value="0" max="100" id="fullcountsProg"></progress> ' +
  '<span class="progValue" id="fullcountsProgVal">0%</span>' +
  '</div>';
var geneColors;
var loadDataset = function(datasetName, datasetObj) {
  datasetName = datasetName.replace("|", "/");
  var dataDir = "data/" + datasetName + "/";

  updateLoadingStatus("loading dataset " + datasetName + "<br />" + progressStatus);
  
  // reset dataset counts/parameters;
  ds.numPos = 0;
  ds.numWindow = 0;
  firstRun = true;
  
  // reset annotations and reload
  annotations = [];
  annotatePos = [];
  layers = [];
  
  geneTip.hide();
  tip.hide();
  
  makeBinaryFileRequest(dataDir + datasetObj.attenuation, 'depth');
  makeBinaryFileRequest(dataDir + datasetObj.metrics[0], 'metric');
  
  if (datasetObj.hasOwnProperty('annotations')) {
    $.getJSON(
      dataDir + datasetObj.annotations, 
      function(data) {
        annotations = data;
        
        var curIndex = 0;
        annotations.forEach(function(d, i) {
          var seqs = d.locations.split(";")
          seqs.forEach(function(seq) {
            pos = seq.split('-');
            newAnnot = {min: +pos[0], max: +pos[1], name: d.gene, geneIndex: i, thisIndex: curIndex++};
            annotatePos.push(newAnnot);
          });
        });
        
        geneColors = d3.scale.category10()
          .domain(annotations.map(function(d) { return d.gene; }));
        
        // generate a layout for these domains, minimizing overlaps
        generateAnnotationLayout();
      }
    );
  }
  
  if (datasetObj.hasOwnProperty('fullcounts')) {
    makeBinaryFileRequest(dataDir + datasetObj.fullcounts, 'fullcounts');
  }
  
  if (datasetObj.hasOwnProperty('refdata')) {
    makeBinaryFileRequest(dataDir + datasetObj.refdata, 'refdata');
  }
};

var getAnnotationForPosition = function(pos) {
  if (annotations.length == 0)
    return [];
  
  matchedAnnotations = [];
  annotatePos.forEach(function(d, i) {
    if (pos >= d.min && pos <= d.max)
      matchedAnnotations.push(annotations[d.geneIndex]);
  });
  
  return matchedAnnotations;
};

// assumes annotations and annotatePos are populated;
// returns: augments annotatePos with layer position to help renderer order named domains
var layers = [];
var generateAnnotationLayout = function() {
  // start by sorting genes by number of disjoint domains, then by position
  var sortedGenes = annotations.slice().sort(function(a, b) {
    numDomainDiff = b.locations.split(";").length - a.locations.split(";").length;
    if (numDomainDiff != 0)
      return numDomainDiff;
    
    return a.min - b.min;
  });
  
  
  // run through the domains
  layers = [[]];
  var overlaps = function(layerIndex, reqDomain) {
    var doesOverlap = false;
    layers[layerIndex].some(function(d) {
      var otherDomain = annotatePos[d];
      
      // get actual mins and maxes
      var reqMin = Math.min(reqDomain.min, reqDomain.max);
      var reqMax = Math.max(reqDomain.min, reqDomain.max);
      var oMin = Math.min(otherDomain.min, otherDomain.max);
      var oMax = Math.max(otherDomain.min, otherDomain.max);
      
      //if ((reqMin >= oMin && reqMin <= oMax) || (reqMax >= oMin && reqMax <= oMax)) {
      if (oMax >= reqMin && oMin <= reqMax) {
        return doesOverlap = true;
      }
      
      return false;
    });
    
    return doesOverlap;
  };
  
  sortedGenes.forEach(function(g) {
    var curLayer = 0;
    var theseDomains = annotatePos.filter(function(d) { return d.name == g.gene; });
    
    // check if this gene overlaps with the other layers, then assign all domains of this gene
    // to a layer
    while (true) {
      var foundFreeLayer = true;
      theseDomains.some(function(domain) {
        foundFreeLayer = !overlaps(curLayer, domain)
        return !foundFreeLayer;
      });
      
      if (foundFreeLayer)
        break;
      
      curLayer++;
      
      // add a layer if we don't have one at the next index
      if (layers[curLayer] === undefined)
        layers[curLayer] = [];
    }
    
    // actually add these to the layer now
    theseDomains.forEach(function(domain) {
      layers[curLayer].push(domain.thisIndex);
    });
  });
};

// checks if this specific read (A, C, T, or G) is a variant at this position
// -- the status of the synonymy checkbox (#dosynonymy) affects the outcome
var DNACodonTable = { 
  'TTT': 'F', 'TTC': 'F', 
  'TTA': 'L', 'TTG': 'L', 'CTT': 'L', 'CTC': 'L', 'CTA': 'L', 'CTG': 'L',
  'ATT': 'I', 'ATC': 'I', 'ATA': 'I',
  'ATG': 'M',
  'GTT': 'V', 'GTC': 'V', 'GTA': 'V', 'GTG': 'V',
  'TCT': 'S', 'TCC': 'S', 'TCA': 'S', 'TCG': 'S',
  'CCT': 'P', 'CCC': 'P', 'CCA': 'P', 'CCG': 'P',
  'ACT': 'T', 'ACC': 'T', 'ACA': 'T', 'ACG': 'T',
  'GCT': 'A', 'GCC': 'A', 'GCA': 'A', 'GCG': 'A',
  'TAT': 'Y', 'TAC': 'Y', 
  'TAA': 'stop', 'TAG': 'stop', 'TGA': 'stop',
  'CAT': 'H', 'CAC': 'H',
  'CAA': 'Q', 'CAG': 'Q',
  'AAT': 'N', 'AAC': 'N',
  'AAA': 'K', 'AAG': 'K',
  'GAT': 'D', 'GAC': 'D',
  'GAA': 'E', 'GAG': 'E',
  'TGT': 'C', 'TGC': 'C',
  'TGG': 'W',
  'CGT': 'R', 'CGC': 'R', 'CGA': 'R', 'CGG': 'R',
  'AGT': 'S', 'AGC': 'S',
  'AGA': 'R', 'AGG': 'R',
  'GGT': 'G', 'GGC': 'G', 'GGA': 'G', 'GGG': 'A'
};
var isReadVariant = function(read, pos) {
  read = read.toUpperCase();
  if (read.length != 1)
    console.warning("Excpected one character for `read` to `isReadVariant` (got %d instead)", read.length);

  // for each annotation that overlaps this position, check if the read at this position
  // would result in a differently-coded amino-acid
  // ...
  // use the function `some` to immediately short-circuit if the read is a non-synoymous
  // read in ANY reading frame.  returns false iff there is a synonymous read in all reading frames
  return getAnnotationForPosition(pos).some(function(annotation) {
    var gene = annotatePos.filter(function(d) { return d.name == annotation.gene; })[0];
    var isBackward = gene.min > gene.max;
    if (isBackward) {
      var codonPos = Math.floor((pos - gene.min) / 3) * 3 + gene.min;
      var readPosInCodon = (pos - gene.min) % 3;
      var containingRefCodon = refString.substring(codonPos, codonPos - 3)
        .split("").reverse().join("");
        
      //var containingCodon = containingRefCodon.substr(0, 
      console.warn("NOT IMPLEMENTED FOR REVERSE READING FRAMES");
    } else {
      var codonPos = Math.floor((pos - gene.min) / 3) * 3 + gene.min;
      var readPosInCodon = (pos - gene.min) % 3;
      var containingRefCodon = refString.substring(codonPos, codonPos + 3);
      var containingCodon = containingRefCodon.substr(0, readPosInCodon) + read 
        + containingRefCodon.substr(readPosInCodon + 1);
        
      //console.log("comparing %s to reference %s (codon starts at %d, this position in codon is at %d)", containingCodon, containingRefCodon, codonPos, readPosInCodon);
      return DNACodonTable[containingRefCodon] != DNACodonTable[containingCodon];
    }
  });
};

// given two positions i, j, calculate the number of variants, non-variants, and synoymic variants
var getSynonymyCounts = function(i, j) {
  if (metrics[i][j].hasOwnProperty('metric_syn'))
    return;

  metrics[i][j].fullcounts.forEach(function(pair) {
    var read_i = pair.base.charAt(0);
    var read_j = pair.base.charAt(2);
    if (!metrics[i][j].fullcounts.hasOwnProperty('i')) {
      pair.i = refString.charAt(i) == read_i ? "m" : isReadVariant(read_i, i) ? "v" : "s";
      pair.j = refString.charAt(j) == read_j ? "m" : isReadVariant(read_j, j) ? "v" : "s";
    }
    
    // add note about synonymous read to metrics entry (if it doesn't exist already)
    if (pair.i == 's') {
      if (!metrics[i][i].hasOwnProperty('synon'))
        metrics[i][i].synon = read_i;
      else if (metrics[i][i].synon.indexOf(read_i) == -1)
        metrics[i][i].synon += read_i;
    } 
    
    if (pair.j == 's') {
      if (!metrics[j][j].hasOwnProperty('synon'))
        metrics[j][j].synon = read_j;
      else if (metrics[j][j].synon.indexOf(read_j) == -1)
        metrics[j][j].synon += read_j;
    }
  });
  
  // add synonymy metric to pair
  var r = getVariantMatrixAtPosSyn(i, j, true);

  var vi = r.vimj + r.vivj;
  var mi = r.mimj + r.mivj;
  var Pvjvi = vi == 0 ? 0 : r.vivj / vi;
  var Pvjmi = mi == 0 ? 0 : r.mivj / mi;
  metrics[i][j].metric_syn = Pvjvi - Pvjmi;
};

var getSynAtPos = function(pos) {
  return metrics[pos][pos].synon;
};

var isSynAtPos = function(read, pos) {
  var syns = metrics[pos][pos].synon;
  if (syns)
    return metrics[pos][pos].synon.indexOf(read) != -1;
  else
    return false;
}

var readAtPos = function(read, pos) {
  if (read == refString.charAt(pos))
    return 'm';
  if (isSynAtPos(read, pos))
    return 's';
  
  return 'v';
};

var getVariantMatrixAtPos = function(i, j) {
  return getVariantMatrixAtPosSyn(i, j, $("#dosynonymy").prop('checked'));
};

var getVariantMatrixAtPosSyn = function(i, j, isSyn) {
  var curCounts = metrics[i][j].fullcounts;
  
  var imreads = refString.charAt(i) + (isSyn ? metrics[i][i].synon || "" : "");
  var jmreads = refString.charAt(j) + (isSyn ? metrics[j][j].synon || "" : "");
  var ivread = function(countEntry) { return imreads.indexOf(countEntry.base.charAt(0)) == -1; };
  var jvread = function(countEntry) { return jmreads.indexOf(countEntry.base.charAt(2)) == -1; };
  
  var ret = {};
  ret['vivj'] = d3.sum(curCounts.filter(function(d) { return  ivread(d) &&  jvread(d); }), function(d) { return d.num; });
  ret['vimj'] = d3.sum(curCounts.filter(function(d) { return  ivread(d) && !jvread(d); }), function(d) { return d.num; });
  ret['mivj'] = d3.sum(curCounts.filter(function(d) { return !ivread(d) &&  jvread(d); }), function(d) { return d.num; });
  ret['mimj'] = d3.sum(curCounts.filter(function(d) { return !ivread(d) && !jvread(d); }), function(d) { return d.num; });
  
  return ret;
};

var checkFilterEntry = function(i, j) {
  curVal = metrics[i][j];
  
  console.log("---- comparison pos %d to %d", +i, +j);
  
  // check for self co-occurrences
  if (i == j) {
    console.warn("position (%d,%d) is a self co-occurrence; removed.", i, j);
    return;
  }
    
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

// add a line to separate overview from detail
d3.select('#d3canvas')
  .append('line')
    .attr('x1', 0)
    .attr('y1', 195)
    .attr('x2', 1000)
    .attr('y2', 195)
    .attr('stroke', '#000')
    .attr('stroke-width', 1)
    .attr('shape-rendering', 'crispEdges');
    
// do the same for sliders?
d3.select('#d3canvas')
  .append('line')
    .attr('x1', 0)
    .attr('y1', 815)
    .attr('x2', 1000)
    .attr('y2', 815)
    .attr('stroke', '#000')
    .attr('stroke-width', 1)
    .attr('shape-rendering', 'crispEdges');
    
var overview = d3.select("#d3canvas")
  .append('g')
    .attr('class', 'overview')
    .attr('transform', 'translate(30, 25)'); 

// function to add comma separators to make human-readable numbers
// <http://stackoverflow.com/questions/2901102/how-to-print-a-number-with-commas-as-thousands-separators-in-javascript>
var dispNum = function(num) {
  return num.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}
    
// add a tip div
var tip = d3.tip()
  .attr('class', 'd3-tip')
  .html(function(d) {
    // ask the annotations if any overlap this position
    var genes = getAnnotationForPosition(d.pos).map(function(thisGene, i) {
      return '<span style="color: ' + geneColors(thisGene.gene) + '">' + thisGene.gene + '</span>';
    });
    
    if (genes.length == 0)
      return d.pos;
    else
      return d.pos + ": " + genes.join(", ");
  });
overview.call(tip);

// add a tip for the gene annotations too
var geneTip = d3.tip()
  .attr('class', 'd3-tip')
  .direction('s')
  .offset(function() {
    var bbox = this.getBBox();
    return [bbox.height, 0];
  })
  .html(function(d) {
    var thisGene = annotatePos[d].name;
    var thisMin = annotatePos[d].min;
    var thisMax = annotatePos[d].max;
    return '<span style="color: ' + geneColors(thisGene) + '">' + thisGene + '</span><span class="geneRange">: [' + thisMin + ',' + thisMax + ']</span>';
  });
overview.call(geneTip);

// TODO: want the layout to be something like:  
// position        proportion of total for position
//   537                   767/800 (95.9%)
var linkTip = d3.tip()
  .attr('id', 'linkTip')
  .attr('class', 'd3-tip')
  .offset([-7, 0])
  .html(function(d) {
    var pos1 = d.i > d.j ? d.j : d.i;
    var pos2 = d.j > d.i ? d.j : d.i;
    
    // always keep lower position first (practioner-ask)
    var iIsFirst = d.i < d.j;
    
    var ret = "Found " + dispNum(d.thisCount) + " reads.<br />";
    ret += "<table><thead><tr>";
    ret += "<th>" + pos1 + "</th><th>" + pos2 + "</th><th># reads</th><th></th>";
    ret += "</tr></thead><tbody>";
    
    // select just those reads that MAKE SENSE (given vari, varj)
    var refi = refString.charAt(d.i) + ($('#dosynonymy').prop('checked') ? metrics[d.i][d.i].synon || "" : "");
    var refj = refString.charAt(d.j) + ($('#dosynonymy').prop('checked') ? metrics[d.j][d.j].synon || "" : "");
    var countScale = d3.scale.linear()
      .domain([0, d.thisCount]).range([1, 100]);
    metrics[d.i][d.j].fullcounts.filter(function(e) { 
      // filter iff XOR is true
      if (refi.indexOf(e.base.charAt(0)) != -1 ? !d.vari : d.vari) {
        if (refj.indexOf(e.base.charAt(2)) != -1 ? !d.varj : d.varj) {
          return true;
        }
      }
      
      return false;
    }).forEach(function(e) {
      var bases = e.base.split(",");
      if (!iIsFirst) bases.reverse();
      
      var cPos1 = cGreen, cPos2 = cGreen;
      if (refString.charAt(pos1) != bases[0]) {
        if (isSynAtPos(bases[0], pos1))
          cPos1 = cWhite;
        else
          cPos1 = cRed;
      } if (refString.charAt(pos2) != bases[1]) {
        if (isSynAtPos(bases[1], pos2))
          cPos2 = cWhite
        else
          cPos2 = cRed;
      }
      
      ret += '<tr><td style="color: '+cPos1+'; font-weight: bold;">' + bases[0] + '</td>';
      ret += '<td style="color: '+cPos2+'; font-weight: bold;">' + bases[1] + '</td>';
      ret += '<td style="text-align: right;">' + dispNum(e.num);
      ret += '</td><td style="text-align: left;">';
      ret += '<div class="sparkbar" style="width: ' + countScale(e.num) + 'px;"></div></td></tr>';
    });
    
    ret += "</tbody></table>";
    
    return ret;
  });
overview.call(linkTip);

// TODO: also a tip for the position variants/non-variants
// d: {pos: #, av: #, vov: # vom: #, am: #, mom: #, mov: #}
var posTip = d3.tip()
  .attr('id', 'posTip')
  .attr('class', 'd3-tip')
  .offset([-7, 0])
  .html(function(d) {
    ret = 'Position '+d.pos+' <span class="subtitle">(found ' + dispNum(d.av+d.am) + ' reads)</span>';
    
    if (refString.length > 1) {
      ret += '<br/><span class="subtitle">Ref. nucleotide: <b>' + refString.charAt(d.pos) + '</b>';
      if (metrics[d.pos][d.pos].hasOwnProperty('synon'))
        ret += ' <small>(synonym nucleotides: <b>' + metrics[d.pos][d.pos].synon.split("").join(", ") + '</b>)</small>';
      ret += '</span>';
    }
    
    // ask the annotations if any overlap this position
    var genes = getAnnotationForPosition(d.pos).map(function(thisGene, i) {
      return '<span style="color: ' + geneColors(thisGene.gene) + '">' + thisGene.gene + '</span>';
    });
    if (genes.length != 0)
      ret += '<br /><span class="genes">' + genes.join(", ") + '</span>';
    ret += "</span>";
    
    if (d.hasOwnProperty('vov')) {
      d.nv = d.av - d.vov - d.vom;
    
      ret += '<div class="breakdown">' + dispNum(d.av) + ' (' + (d.av/(d.av+d.am) * 100).toFixed(1) + '% of total)';
      ret += ' reads are variant.';
      ret += '<div class="moredetails">' + dispNum(d.nv) + '  (' + (d.nv/d.av*100).toFixed(1) + '%)';
      ret += ' do not overlap ' + d.opos + '<br />';
      ret += dispNum(d.vov) + ' (' + (d.vov/d.av*100).toFixed(1) + '%) link to variants at ' + d.opos + '<br />';
      ret += dispNum(d.vom) + ' (' + (d.vom/d.av*100).toFixed(1) + '%) link to reference at ' + d.opos;
      ret += '</div></div>';
    } else {
      d.nm = d.am - d.mom - d.mov;
    
      ret += '<div class="breakdown">' + dispNum(d.am) + ' (' + (d.am/(d.av+d.am) * 100).toFixed(1) + '% of total)';
      ret += ' reads are wild-type.';
      ret += '<div class="moredetails">' + dispNum(d.nm) + '  (' + (d.nm/d.am*100).toFixed(1) + '%)';
      ret += ' do not overlap ' + d.opos + '<br />';
      ret += dispNum(d.mom) + ' (' + (d.mom/d.am*100).toFixed(1) + '%) link to variants at ' + d.opos + '<br />';
      ret += dispNum(d.mov) + ' (' + (d.mov/d.am*100).toFixed(1) + '%) link to reference at ' + d.opos;
      ret += '</div></div>';
    }
    
    ret += '<div class="breakdown">Nucleotides at this position';
    ret += '<div class="moredetails"><table>';
    var sparkScale = d3.scale.linear()
      .domain([0, d.av + d.am]).range([1, 50]);
      
    metrics[d.pos][d.pos].fullcounts.forEach(function(e) {
      var textColor = e.base.charAt(0) == refString.charAt(d.pos) ? cGreen : 
        metrics[d.pos][d.pos].synon && metrics[d.pos][d.pos].synon.indexOf(e.base.charAt(0)) != -1 ? 
          cWhite : cRed;
      ret += '<tr style="color: ' + textColor + ';"><td>' + e.base.charAt(0) + '</td><td style="text-align: right;">' + dispNum(e.num);
      ret += '</td><td><div class="sparkbar" style="width: ' + sparkScale(e.num) + 'px;"></div></td></tr>';
    });
    
    return ret;
  });
overview.call(posTip);

var cRed = 'rgb(197,65,65)';
var cGreen = 'rgb(153,207,153)';
var cGray = 'rgba(128,128,128,0.5)';
var cWhite = '#ddd';
    
var detailView = d3.select("#d3canvas")
  .append('g')
    .attr('class', 'detail')
    .attr('transform', 'translate(30, 200)');
    
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
  .attr('stop-color', cRed)
  .attr('stop-opacity', 1);

gradient.append('stop')
  .attr('offset', '100%')
  .attr('stop-color', cGreen)
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
  .attr('stop-color', cGreen)
  .attr('stop-opacity', 1);

gradient.append('stop')
  .attr('offset', '100%')
  .attr('stop-color', cRed)
  .attr('stop-opacity', 1);
      
var x = d3.scale.ordinal()
  .rangeBands([0, 940], 0.1);
  
var y = d3.scale.ordinal()  // only show two entries
  .range([50,350]);
y.rangeBand = function() { return 200; }; // hack to keep d3 paradigm
  
var miniBarY = d3.scale.ordinal()
  .domain(['depth', 'variant', 'metric'])
  .rangeBands([50,100], 0.1);
  
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
  
var seqScale = d3.scale.linear()
  .range([0, 940]);
  
var seqAxis = d3.svg.axis() 
  .ticks(10)
  .orient('top');

var numBins = 7;
var makeSlider = function(type) {
  var colors, sliderX, displayFunc, startVal, dataDomain, sliderName;
  
  switch (type) {
    case 'depth':
      colors = depthScale.range();
      startVal = 25;
      displayFunc = function(d) { return ">" + Math.round(d) + "%"; };
      sliderX = 125;
      dataDomain = [0, metrics.bounds.depth.max]; 
      sliderName = "Read Depth";
      break;
    case 'variant':
      colors = variantScale.range();
      startVal = 10;
      displayFunc = function(d) { return ">" + Math.round(d) + "%"; };
      sliderX = 450;
      dataDomain = [0, 1];
      sliderName = "Variant %";
      break;
    case 'metric':
      colors = metricScale.range();
      startVal = 30;
      displayFunc = function(d) { return "> |" + (d / 100).toFixed(1) + "|"; };
      sliderX = 775;
      dataDomain = [0, 1];
      sliderName = "Co-occurrence Metric";
      break;
    default:
      console.error('got unknown type for slider');
      return;
  }
  
  var xScale = d3.scale.linear().domain([0, 100]).range([0, 100]).clamp(true);
  brushes[type] = d3.svg.brush()
    .x(xScale)
    .extent([0,0])
    .on('brush', brushed)
    .on('brushend', brushended);
    
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
    .call(brushes[type]);
    
  // remove unused aspects of the brush, and modify the clickable area
  slider.selectAll('.extent,.resize').remove();
  slider.select('.background').attr('height', 20).attr('transform', 'translate(0,40)');

  // add the circular handle
  var handle = slider.append('circle')
    .attr('class', 'handle')
    .attr('transform', 'translate(0,50)')
    .attr('r', 9);
    
  // add the slider title
  sliderGroup.append('text')
    .attr('class', 'slider-name')
    .attr('x', -15)
    .attr('y', 4)
    .style('text-anchor', 'end')
    .style('font-size', '13px')
    .text(sliderName);
    
  // add an indication of the current value
  var sliderLabel = sliderGroup.append('g')
    .attr('attr', 'slider-label')
    .attr('transform', 'translate(0,12)');
    
  sliderLabel.append('line')
    .attr({x1: 0, x2: 0, y1: 0, y2: 12 })
    .style('stroke', '#fff')
    .style('stroke-linecap', 'round')
    .style('stroke-width', 5);
    
  sliderLabel.append('line')
    .attr({x1: 0, x2: 0, y1: 0, y2: 12 })
    .style('stroke', '#000')
    .style('stroke-linecap', 'round')
    .style('stroke-width', 1);
    
  var sliderText = sliderLabel.append('text')
    .attr('class', 'slider-text')
    .attr('x', 0)
    .attr('y', 25)
    .style('text-anchor', 'middle')
    .style('font-size', '11px')
    .style('font-weight', '800')
    .text('TBD');
  
  // do base histogram bars now
  if (doHistograms) {
    histoScales.x[type] = d3.scale.linear()
      .domain(dataDomain)
      .range([0, 100]);
      
    var barGroup = sliderParent.append('g')
      .attr('class', 'legend-bars')
      .attr('transform', 'translate(0,-10)');
    
    // compute thresholds for histogram binning
    // thanks to <http://stackoverflow.com/questions/20367899/d3-js-controlling-ticks-and-bins-on-a-histogram>
    var tempScale = d3.scale.linear()
      .domain([0,numBins])
      .range(dataDomain);
    binThresholds[type] = d3.range(numBins+1).map(tempScale);
    
    var barData = d3.layout.histogram()
      .bins(binThresholds[type])
      (threshCounts[type]);
    
    histoScales.y[type] = d3.scale.linear()
      .domain([0, d3.max(barData, function(d) { return d.y; })])
      .range([50, 0]);
      
    var bar = barGroup.selectAll('.bar')
      .data(barData)
        .enter().append('g')
          .attr('class', 'bar')
          .attr('transform', function(d) {
            return 'translate(' + histoScales.x[type](d.x) + ',' + histoScales.y[type](d.y) + ')';
          });
          
    bar.append('rect')
      .attr('x', 1)
      .attr('width', histoScales.x[type](barData[0].dx) - 1)
      .attr('height', function(d) {
        return 50 - histoScales.y[type](d.y);
      });
      
  }
    
  // finally, call the slider events to set everything up
  slider.call(brushes[type].extent([startVal,startVal])).call(brushes[type].event);
  
  function brushed() {
    var val = brushes[type].extent()[0];
    if (d3.event.sourceEvent) {  // e.g. not a programmatic event
      val = xScale.invert(d3.mouse(this)[0]);
      brushes[type].extent([val, val]);
    }
    
    handle.attr('cx', xScale(val));
    
    // update labels
    sliderLabel.attr('transform', 'translate(' + xScale(val) + ',12)');
    sliderText.text(displayFunc(val));
  };
  
  function brushended() {
    var val = brushes[type].extent()[0];
    if (d3.event.sourceEvent) {  // e.g. not a programmatic event
      val = xScale.invert(d3.mouse(this)[0]);
      brushes[type].extent([val, val]);
    }
    
    if (!firstRun) {
      switch (type) {
        case 'metric':
          minMetric = val / 100;
          break;
        case 'variant':
          minVariants = val / 100;
          break;
        case 'depth':
          minDepthPercent = val / 100; 
          break;
      }
      
      filterData();
      updateVis();
    }
  };
};

// assumes seqScale is populated with a domain
var clusters = [];
var clusterAssignment = {};
var clusterDist = 3;
var clusterPositions = function() {
  positions = filtered.map(function(d) { return +d.pos; });
  
  // reset the clusters
  clusters = [];
  clusterAssignment = {};
  
  var cluster = -1;
  var prevPos = -10;
  for (var i = 0; i < positions.length; i++) {
    var thisSeq = positions[i];
    var thisPos = seqScale(thisSeq);
    
    if (thisPos < prevPos + 3) {
      clusters[cluster]['max'] = thisSeq;
      clusterAssignment[thisSeq] = cluster;
    } else {
      clusters[++cluster] = {};
      clusters[cluster]['min'] = thisSeq;
      clusters[cluster]['max'] = thisSeq;
      clusterAssignment[thisSeq] = cluster;
    }
    
    prevPos = thisPos;
  }
  
  // augment the x domain with gaps between clusters
  var thisDomain = x.domain();
  clusters.forEach(function(d, i) {
    if (i == clusters.length - 1) return;
    thisDomain.splice(thisDomain.indexOf(d.max) + 1, 0, 'cluster' + i);
  });
  
  x.domain(thisDomain);
};

// assumes layers and annotationPos variables have been populated
// TODO: make sure backwards reading frames work (e.g. min is actually max; arrow points backwards)
var drawAnnotations = function() {
  // add the annotation group if it doesn't exist
  var annots = overview.selectAll('g.annotations')
    .data([layers.reduce(function(p, d) { return p + "," + d.length; }, "")])
    .enter()
    .append('g')
      .attr('class', 'annotations')
      .attr('transform', 'translate(0,-20)');
      
  annotY = d3.scale.ordinal()
    .domain(d3.range(layers.length))
    .rangeRoundBands([0, 30], 0.1);
      
  var annotLayer = annots.selectAll('g.annotationLayer').data(layers)
    .enter()
    .append('g')
      .attr('class', 'annotationLayer')
      .attr('transform', function(d, i) { return 'translate(0,' + annotY(i) + ')'; });
      
  var annot = annotLayer.selectAll('g.annotation')
    .data(function(layer) { return layer; })
    .enter()
    .append('g')
      .attr('class', 'annotation')
      .append('rect')
        .attr('x', function(d) { return seqScale(Math.min(annotatePos[d].min, annotatePos[d].max)); })
        .attr('width', function(d) { return Math.abs(seqScale(annotatePos[d].max) - seqScale(annotatePos[d].min)); })
        .attr('height', annotY.rangeBand())
        .attr('title', function(d) { return annotatePos[d].name; })
        .style('fill', function(d) { return geneColors(annotatePos[d].name); })
        .on('mouseover', geneTip.show)
        .on('mouseout', geneTip.hide);
  
};

var detailScales = {};
var detailData = [];    

var updateVis = function() { 
  // update histograms
  if (doHistograms) updateHistograms();

  // do the brain-dead thing and just wipe everything
  overview.selectAll('g.ipos').remove();
  overview.selectAll('g.wedge').remove();
  detailView.selectAll('*').remove();
  
  // set domains that depend on bounds of data
  metricColorScale.domain([
    metrics.bounds.metric.min, 
    metrics.bounds.metric.max
  ]);
  depthScale.domain([metrics.bounds.depth.min, metrics.bounds.depth.max]);
  
  seqScale.domain(d3.extent(Object.keys(metrics).map(function(d) { return +d; })));
  seqAxis.scale(seqScale);

  // add the axis if it doesn't exist
  var seqAxisGrp = overview.selectAll('g.seqAxis').data([seqScale.domain()]);
  
  seqAxisGrp.enter()
    .append('g')
      .attr('class', 'x axis seqAxis')
      .attr('transform', 'translate(0,30)')
      .call(seqAxis);
  seqAxisGrp.exit().remove();
  
  if (annotations.length != 0)
    drawAnnotations();

  // assume that filtered is populated here
  var ipos = overview.selectAll('g.ipos')
    .data(filtered, function(d) { return d.pos });
    
  // set the x domain
  x.domain(filtered.map(function(d) { return d.pos; }));
  
  clusterPositions();
    
  // ENTER STEP
  var newPos = ipos.enter()
    .append('g')
      .attr('class', 'ipos')
      .attr('transform', function(d) { 
        return 'translate(' + x(d.pos) + ',30)';
      })
      .on('click', function(datum, i) {
        detailData = filtered[i].relatedPairs;
        updateDetail();
      })
      .on('mouseover', function(d) {
        d3.select('.cluster' + clusterAssignment[d.pos]).classed('selected', true);
        tip.show(d);
      })
      .on('mouseout', function(d) {
        d3.select('.cluster' + clusterAssignment[d.pos]).classed('selected', false);
        tip.hide(d);
      });
      
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
      var thisMax = d3.max(d.relatedPairs, function(e) {
        var c = getVariantMatrixAtPosSyn(e.posi, e.posj);
        return Math.max(c.vivj + c.vimj, c.vivj + c.mivj) / e.depth;
      });
      
      return variantScale(thisMax);
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
          return Math.abs($("#dosynonymy").prop('checked') ? e.metric_syn : e.metric); 
        })
      );
    });
    
  // be smart about when we diagonalize (when we have less than 20px space)
  var widthLimit = 25;
  newPos.append('text')
    .attr('class', 'labelpos')
    .attr('x', function() { 
      if (x.rangeBand() >= widthLimit) 
        return x.rangeBand() / 2;
      else
        return x.rangeBand() * 2 / 3;
    })
    .attr('y', function() {
      if (x.rangeBand() >= widthLimit)
        return miniBarHeight + 15;
      else 
        return miniBarHeight + 7;
    })
    .style('text-anchor', function() {
      if (x.rangeBand() >= widthLimit)
        return 'middle';
      else 
        return 'end';
    })
    .attr('transform', function() {
      if (x.rangeBand() >= widthLimit)
        return null;
      else 
        return 'rotate(-65,' + (x.rangeBand() * 2 / 3) + ',' + (miniBarHeight+7) + ')';
    })
    .text(function(d) { return d.pos; });
    
  // try to append some shapes on the axis ??
  /*
  newPos.append('rect')
    .attr('x', function(d) { 
      return seqScale(d.pos) - x(d.pos) - 1;
    })
    .attr('y', -4)
    .attr('height', 4)
    .attr('width', 2)
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
    .attr('x', function(d) { 
      return seqScale(d.pos) - x(d.pos) - 1;
    })
    .attr('y', -8)
    .attr('height', 4)
    .attr('width', 2)
    .style('fill', function(d) {
      return metricScale(
        d3.max(d.relatedPairs, function(e) { 
          return Math.abs(e.metric); 
        })
      );
    });
  */
  
  // make wedges
  var newWedges = overview.selectAll('g.wedge')
    .data(clusters, function(d) { return d.min + "," + d.max;})
    .enter()
      .append("g")
        .attr('class', 'wedge')
        .attr('transform', 'translate(0,30)');
        
  newWedges.append('path')
    .attr('d', function(d) { 
      var path = "";
      if (d.min != d.max) {
        path = "M " + (x(d.min) + x.rangeBand() / 2) + " 50";
        path += " L " + (x(d.max) + x.rangeBand() / 2) + " 50";
        path += " L " + seqScale(d.max) + " 0";
        path += " L " + seqScale(d.min) + " 0";
      } else {
        path = "M " + (x(d.min) + 1 * x.rangeBand() / 4) + " 50";
        path += " L " + (x(d.min) + 3 * x.rangeBand() / 4) + " 50";
        path += " L " + (seqScale(d.min) + x.rangeBand() / 4) + " 0";
        path += " L " + (seqScale(d.min) - x.rangeBand() / 4) + " 0";
      }
        
      return path;
    })
    .attr('class', function(d, i) {
      return 'cluster' + i;
    });
    
  
  hideLoading();
};


// type is one of {'metric', 'depth', 'variants'}
var makeColorRamp = function(type, parent, i, label, width, height) {
  makeColorRampAbsPos(type, parent, 0, i * 35, label, "", width, height);
};

var makeColorRampAbsPos = function(type, parent, x, y, label, title, width, height) {
  width = width || 63;
  height = height || 6;
  
  var calcVar;
  var scale;
  switch (type) {
    case 'metric':
      scale = metricColorScale;
      calcVar = function(d) {
        return $("#dosynonymy").prop('checked') ? d.metric_syn : d.metric;
      };
      break;
    case 'depth':
      scale = depthScale;
      break;
    case 'vari':
      scale = variantScale;
      calcVar = function(d) {
        var c = getVariantMatrixAtPos(d.posi, d.posj);
        return (c.vivj + c.vimj) / d.depth;
      };
      break;
    case 'varj':
      scale = variantScale;
      calcVar = function(d) {
        var c = getVariantMatrixAtPos(d.posi, d.posj);
        return (c.vivj + c.mivj) / d.depth;
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
    .attr('transform', 'translate(' + x + ',' + y + ')');
    
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
    
  //ramp.append('text')
  //  .attr('x', width + 13)
  //  .attr('y', 23)
  //  .text(label);
  ramp.append('text')
    .attr('x', function(d) {
      if (calcVar)
        return indiScale(calcVar(d));
      else
        return indiScale(d[type]); 
    })
    .attr('y', 40)
    .attr('text-anchor', 'middle')
    .attr('font-size', '0.6em')
    .text(label);
    
  ramp.append('text')
    .attr('x', Math.round(width / 2))
    .attr('y', -5)
    .attr('text-anchor', 'middle')
    .text(title);
    
    
  if (type == "vari") {
    ramp.append('text')
      .attr('x', width + 7)
      .attr('y', 7)
      .text(function(d) { return d.posi; });
  } else if (type == "varj") {
    ramp.append('text')
      .attr('x', width + 7)
      .attr('y', 7)
      .text(function(d) { return d.posj; });
  }
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
    .data(curDetail, function(d) { return d.posi + "," + d.posj; }); 
    
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
    
  makeColorRampAbsPos('metric', newDetail, 15, 145,
    function(d) { 
      return $("#dosynonymy").prop('checked') ? d.metric_syn.toFixed(3) : d.metric.toFixed(3);
    }, "correlation");
    
  makeColorRampAbsPos('depth', newDetail, 115, 145,
    function(d) {
      return (d.depth / metrics['bounds']['depth']['max'] * 100).toFixed(2) + "%";
    }, "depth");
    
  makeColorRampAbsPos('vari', newDetail, 215, 145,
    function(d) {
      var c = getVariantMatrixAtPos(d.posi, d.posj);
      return ((c.vivj + c.vimj) / d.depth * 100).toFixed(1) + "%"; 
    }, "variants");
    
  makeColorRampAbsPos('varj', newDetail, 215, 190,
    function(d) {
      var c = getVariantMatrixAtPos(d.posi, d.posj);
      return ((c.vivj + c.mivj) / d.depth * 100).toFixed(1) + "%";
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
  
  // if the width is under 200, don't do tooltips
  var doTips = width >= 200;
  
  // figure out whether we should flip (keep lower position on the left)
  parentGrp.attr('transform', function(d) {
    var preTranslate = d3.select(this).attr('transform');
    if (d.posj > d.posi) {
      if (preTranslate)
        return preTranslate + 'translate(' + width + ',0)scale(-1,1)';
      else
        return 'translate(' + width + ',0)scale(-1,1)';
    } else {
      return preTranslate;
    }
  });

  // initialize the detail scales and 
  // draw two blocks
  var s = function(curData, counts) { 
    return detailScales[curData.posi + "," + curData.posj](counts);
  };

  var pairCounts = function(d, compute) { return compute(getVariantMatrixAtPos(d.posi, d.posj)); };
  var vi = function(d) { return pairCounts(d, function(c) { return c.vivj + c.vimj; }) };
  var mi = function(d) { return pairCounts(d, function(c) { return c.mivj + c.mimj; }) };
  var vj = function(d) { return pairCounts(d, function(c) { return c.vivj + c.mivj; }) };
  var mj = function(d) { return pairCounts(d, function(c) { return c.vimj + c.mimj; }) };
  
  var vivj = function(d) { return pairCounts(d, function(c) { return c.vivj; }) };
  var vimj = function(d) { return pairCounts(d, function(c) { return c.vimj; }) };
  var mivj = function(d) { return pairCounts(d, function(c) { return c.mivj; }) };
  var mimj = function(d) { return pairCounts(d, function(c) { return c.mimj; }) };
  
  var fullCount = function(pos, compute) { return compute(getVariantMatrixAtPos(pos, pos)); };
  var avi = function(d) { return fullCount(d.posi, function(c) { return c.vivj; }); };
  var ami = function(d) { return fullCount(d.posi, function(c) { return c.mimj; }); };
  var avj = function(d) { return fullCount(d.posj, function(c) { return c.vivj; }); };
  var amj = function(d) { return fullCount(d.posj, function(c) { return c.mimj; }); };
  
  // add in the paths now
  // var i to var j
  
  // the size of the gap between classes of reads
  var gap = height * 0.125;
  
  var overlap = 2;
  var rectW = width * percentRectWidth + overlap;
  var areaW = width - 2 * (width * percentRectWidth);
  
  // variants of pos_j
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
    .style('fill', cRed)
    .on('mouseover', function(d) {
      var tc = {pos: d.posj, opos: d.posi, am: amj(d), av: avj(d), vov: vivj(d), vom: mivj(d)};
      if (doTips) posTip.show(tc);
    })
    .on('mouseout', function(d) {
      posTip.hide();
    });
    
  // non-variants of pos_j
  parentGrp.append('rect')
    .attr('x', 0)
    .attr('y', function(d) {
      return s(d, avj(d)) + gap;
    })
    .attr('height', function(d) {
      return s(d, amj(d));
    })
    .attr('width', rectW)
    .style('fill', cGreen)
    .on('mouseover', function(d) {
      var tc = {pos: d.posj, opos: d.posi, am: amj(d), av: avj(d), mom: vimj(d), mov: mimj(d)};
      if (doTips) posTip.show(tc);
    })
    .on('mouseout', function(d) {
      posTip.hide();
    });
    
  // variants of pos_i
  parentGrp.append('rect')
    .attr('x', width - rectW)
    .attr('y', 0)
    .attr('height', function(d) {
      return s(d, avi(d));
    })
    .attr('width', rectW)
    .style('fill', cRed)
    .on('mouseover', function(d) {
      var tc = {pos: d.posi, opos: d.posj, am: ami(d), av: avi(d), vov: vivj(d), vom: vimj(d)};
      if (doTips) posTip.show(tc);
    })
    .on('mouseout', function(d) {
      posTip.hide();
    });
    
  // non-variants of pos_i
  parentGrp.append('rect')
    .attr('x', width - rectW)
    .attr('y', function(d) {
      return s(d, avi(d)) + gap;
    })
    .attr('height', function(d) {
      return s(d, ami(d));
    })
    .attr('width', rectW)
    .style('fill', cGreen)
    .on('mouseover', function(d) {
      var tc = {pos: d.posi, opos: d.posj, am: ami(d), av: avi(d), mom: mivj(d), mov: mimj(d)};
      if (doTips) posTip.show(tc);
    })
    .on('mouseout', function(d) {
      posTip.hide();
    });
    
  // append position labels
  parentGrp.append('text')
    .attr('class', 'poslabel')
    .attr('x', Math.floor(rectW / 2))
    .attr('y', height + 20)
    .attr('transform', function(d) {
      if (d.posj > d.posi)
        return 'translate(' + (2 * (Math.floor(rectW / 2))) + ',0)scale(-1,1)';
    })
    .text(function(d) { return d.posj; });  
    
  parentGrp.append('text')
    .attr('class', 'poslabel')
    .attr('x', width - Math.ceil(rectW / 2))
    .attr('y', height + 20)
    .attr('transform', function(d) {
      if (d.posj > d.posi)
        return 'translate(' + (2 * (width - Math.ceil(rectW / 2))) + ',0)scale(-1,1)';
    })
    .text(function(d) { return d.posi; });

  // path-specific coordinates
  var leftX = rectW - overlap;
  var rightX = width - (rectW - overlap);
    
  // handle var_i excess
  var exitAngle = Math.PI / 4;
  var len = areaW * 0.15;
  var calcLeaving = function(d, type) {
    var xDir, yDir, n;
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
    .style('fill', cGray);
    
  parentGrp.append('path')
    .attr('d', function(d) { 
      return calcLeaving(d, 'mi');
    })
    .style('fill', cGray);
    
  parentGrp.append('path')
    .attr('d', function(d) { 
      return calcLeaving(d, 'vj');
    })
    .style('fill', cGray);
  
  parentGrp.append('path')
    .attr('d', function(d) { 
      return calcLeaving(d, 'mj');
    })
    .style('fill', cGray);

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
    .style('fill', cRed)
    .on('mouseover', function(d) {
      var tc = { thisCount: vivj(d), totali: avi(d), totalj: avj(d), i: d.posi, j: d.posj, vari: true, varj: true };
      if (doTips) linkTip.show(tc);
    })
    .on('mouseout', function(d) { linkTip.hide(); });
    
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
    .style('fill', 'url(#modalToVar)')
    .on('mouseover', function(d) {
      var tc = { thisCount: vimj(d), totali: avi(d), totalj: amj(d), i: d.posi, j: d.posj, vari: true, varj: false };
      if (doTips) linkTip.show(tc);
    })
    .on('mouseout', function(d) { linkTip.hide(); });
    
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
    .style('fill', 'url(#varToModal)')
    .on('mouseover', function(d) {
      var tc = { thisCount: mivj(d), totali: ami(d), totalj: avj(d), i: d.posi, j: d.posj, vari: false, varj: true };
      if (doTips) linkTip.show(tc);
    })
    .on('mouseout', function(d) { linkTip.hide(); });
    
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
    .style('fill', cGreen)
    .on('mouseover', function(d) {
      var tc = { thisCount: mimj(d), totali: ami(d), totalj: amj(d), i: d.posi, j: d.posj, vari: false, varj: false };
      if (doTips) linkTip.show(tc);
    })
    .on('mouseout', function(d) { linkTip.hide(); });
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
      d3.select("#d3canvas .sliders").selectAll("*").remove();
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
        defaultDataset = 'VHA4_P11_F21_DPI3-ref';
        curDataset = datasets.hasOwnProperty(defaultDataset) ? defaultDataset : Object.keys(datasets)[0];
      }
      
      // update the current button text
      $("#currentDataset").html(curDataset);
      
      // actually load the dataset (matrixviewer.js)
      var dividerPos = curDataset.indexOf('|');
      var actualData = dividerPos == -1 ? curDataset : curDataset.substring(0, dividerPos);
      
      loadDataset(curDataset, datasets[actualData]);
    }

    // if `ignoreHashChange` was true, set it to `false` for the next call
    ignoreHashChange = false;
  };
  
  window.addEventListener('hashchange', checkHash, false);
  
  $.getJSON("definedData.json", function(data, status) {
    datasets = data.datasets;
    $("#datasetOptions").html("")
    
    for (dataset in datasets) {
      // handle submenus to support multiple genomes for the same dataset
      if (datasets[dataset].hasOwnProperty("subunits")) {
        var retStr = '<li class="dropdown-submenu">';
        retStr += '<a data-toggle="dropdown" tabindex="0" aria-expanded="false">' + dataset;
        retStr += '</a><ul class="dropdown-menu">';
      
        // assume that subunits has menus further
        for (subunit in datasets[dataset].subunits) {
          retStr += '<li class="dropdown-submenu">';
          retStr += '<a data-toggle="dropdown" tabindex="0" aria-expanded="false">' + subunit;
          retStr += '</a><ul class="dropdown-menu">';
          
          var subdata = datasets[dataset].subunits[subunit];
          subdata.forEach(function(subdatum) {
            retStr += '<li><a href="#' + dataset + "|" + subdatum + '">' + subdatum + '</a></li>';
          });
          
          retStr += "</ul></li>";
        }
        
        retStr += "</ul></li>";
        $("#datasetOptions").append(retStr);
        $('.dropdown-submenu > a').submenupicker();
        
      } else {
        $("#datasetOptions").append('<li><a href="#' + dataset + '">' + dataset + '</a></li>');
      }
    }
    
    checkHash();
  });
  
  doHistograms = $("#dostats").prop('checked');
  $("#dostats").change(function() {
    doHistograms = $("#dostats").prop('checked');

    // remove all data from the canvas
    d3.select("#d3canvas .overview").selectAll("*").remove();
    d3.select("#d3canvas .detail").selectAll("*").remove();
    d3.select("#d3canvas .sliders").selectAll("*").remove();
    
    // draw the visualization from scratch
    firstRun = true;
    continueIfDone();
  });
  
  var synChange = function() {
    $("#keepsynonpairs").prop('disabled', !$("#dosynonymy").prop('checked'));
    
    // filter in all cases unless both checkboxes are checked
    //if (!($("#keepsynonpairs").prop('checked') && $("#dosynonymy").prop('checked')))
    filterData();
    updateVis();
    
    d3.selectAll("g.jpos").remove();
    if (detailData.length != 0) 
      updateDetail(curPage || 0);
    
    // after all requested filtering is done, keep disabled checkbox checked
    // if (!$("#dosynonymy").prop('checked')) $("#keepsynonpairs").prop('checked', true);
  };
  
  $("#dosynonymy").change(synChange);
  $("#keepsynonpairs").change(synChange);
  
  $("#customPairSubmit").click(function(e) {
    e.preventDefault(); // don't reload the page
  
    var pos1 = +$("#pickedPos1").val();
    var pos2 = +$("#pickedPos2").val();
    
    if (!metrics.hasOwnProperty(pos1) || !metrics[pos1].hasOwnProperty(pos2)) {
      $("#custompairFeedback").css('display', 'block');
      return;
    }
    
    // hide the modal dialog
    $("#custompair").modal('hide');
    
    
    getSynonymyCounts(pos1, pos2);
    detailData = [metrics[pos1][pos2]];
    updateDetail();
  });
  
  // hide the error message whenever the modal is hidden
  $("#custompair").on('hidden.bs.modal', function() { 
    $("#custompairFeedback").css('display', 'none');
  });
  
  $("#custompair").on('shown.bs.modal', function() {
    $("#pickedPos1").focus();
  });
  
  // continueIfDone() will handle the rest once the files are loaded
});

