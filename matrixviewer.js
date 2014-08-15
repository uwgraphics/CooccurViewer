var gl = GL.create();

window.onload = main;

var dataReady = false;
var timer = null;

var shaders = [];
var textures = [];
var plane, indicator;

var ds = {
  data: [],
  buf: 0,
  numWindow: 0,
  numPos: 0,
  maxVal: 0,
  name: ""
};

var screenOffset = [0, 0];
var scale = 1;
var offset = [0, 0];

var parseFile = function(text) {
  dataReady = false;
  
  var delimiter = ",";
  var lines = text.trim("\r").split("\n");
  for (var i = 0; i < lines.length; i++) {
    lines[i] = lines[i].split(delimiter);
  }
  
  ds.data = [];
  ds.numPos = lines.length;
  ds.numWindow = lines[0].length;
  
  for (var i = 0; i < lines.length; i++) {
    for (var j = 0; j < ds.numWindow; j++) {
      var curValue = +lines[i][j];
      
      // x,y position and z is the value
      var thisItem = [i, j, curValue];
      
      // keep track of the largest value we've seen so far
      ds.maxVal = Math.max(ds.maxVal, curValue);
      
      // push the point to the data stack
      ds.data.push(thisItem);
    }
  }
  
  // create the pixels necessary to create an image for the overview
  ds.bmpData = [];
  for (var i = 0; i < ds.numWindow; i++) {
    ds.bmpData.push([]);
  }
  
  // be smart about the largest texture size.  try to get as much detail as possible
  var maxTexSize = gl.getParameter(gl.MAX_TEXTURE_SIZE);
  
  // do the naive thing if we're smaller than the max texture size
  if (ds.numPos < maxTexSize) {  
    for (var i = 0; i < ds.data.length; i = i + 1) {
      ds.bmpData[i % ds.numWindow][Math.floor(i / ds.numWindow)] = 
        [Math.floor(255 * (ds.data[i][2] / ds.maxVal)), 0, 0];
    }  
  } else {
    var numPixelsToCollapse = Math.ceil(ds.numPos / maxTexSize);
    var texWidth = Math.ceil(ds.numPos / numPixelsToCollapse);
    for (var y = 0; y < ds.numWindow; y++) {
      for (var x = 0; x < texWidth; x++) {
        // get corresponding vertices from ds.data
        var numPixels = numPixelsToCollapse;
        var sumPixels = 0;
        
        for (var n = 0; n < numPixelsToCollapse; n++) {
          var curIndex = ((x * numPixelsToCollapse) + n) * ds.numWindow + y;
          
          if (curIndex < ds.numPos * ds.numWindow) {
            sumPixels += ds.data[curIndex][2];
          } else {
            numPixels--;
          }
        }
        
        if (numPixels <= 0) {
          ds.bmpData[y][x] = [0, 0, 0];
          continue;
        }
          
        var val = Math.floor(255 * ((sumPixels / numPixels) / ds.maxVal));
        ds.bmpData[y][x] = [val, 0, 0];
      }
    }
  }
  
  // compile the GPU data buffer
  ds.buf = new GL.Buffer(gl.ARRAY_BUFFER, Float32Array);
  ds.buf.data = ds.data;
  ds.buf.compile(gl.STATIC_DRAW);
  
  dataReady = true;
  
  debugImg();  
};

// construct a bitmap image using `bitmap.js`.
// used as a debugging tool, but also creates the bitmap to load into the texture
var debugImg = function() {
  var img = new Image();
  
  img.src = generateBitmapDataURL(ds.bmpData);
  img.width = 800;
  img.id = "bmpimg";
  document.getElementById("img-container").appendChild(img);
};

var setInitBounds = function() {
  var b = [[0, 344], [0, 301]];
  
  offset = [-(b[0][0] + b[0][1]) / 2.0, -(b[1][0] + b[1][1]) / 2.0];
  
  scale = Math.max(b[0][1] - b[0][0], b[1][1] - b[1][0]);
  scale = gl.canvas.height / scale;
  
  screenOffset = [gl.canvas.width / 2.0, gl.canvas.height / 2.0];
};

var setZoomPan = function() {
  gl.loadIdentity();
  gl.translate(screenOffset[0], screenOffset[1], 0);
  gl.scale(scale, scale, 1);
  gl.translate(offset[0], offset[1], 0);
};

var debugTexture = function(tex, x, y, w, h, nodebug) {
  // Be a little lenient with texture, allow passing in GL.Texture (lightgl).
  if (Object.prototype.toString.call(tex).indexOf("WebGLTexture") == -1)
    tex = tex.id;

  w = w || 2;
  h = h || 2;
  ds.fbo = ds.fbo || gl.createFramebuffer();
  gl.bindFramebuffer(gl.FRAMEBUFFER, ds.fbo);
  gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
  
  var pixels = new Uint8Array(w * h * 4);
  if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) == gl.FRAMEBUFFER_COMPLETE) {
    gl.readPixels(x, y, w, h, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
    if (!nodebug) {
      console.log("Reading from texture coords (" + x + ", " + y + ") to (" + (x+w) + ", " + (y+h) + "):");
      console.log(pixels);
    }
  }
  
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  return pixels;
};

// each x is worth this much in numPos
var transformOverivewX = function(x) {
  return x * (ds.numPos / gl.canvas.width);
};

var untransformX = function(x) {
  return x * (gl.canvas.width / ds.numPos);
};

var texturesCreated = false;
var createTextures = function() {
  var defaultOpts = {
    magFilter: gl.LINEAR,
    minFilter: gl.NEAREST,
    format:    gl.RGBA,
    type:      gl.UNSIGNED_BYTE
  };
  
  // try rendering from an image
  textures['full'] = GL.Texture.fromImage(document.getElementById("bmpimg"), defaultOpts);
  
  // clean up state
  gl.bindTexture(gl.TEXTURE_2D, null);
  
  texturesCreated = true;
  
  // fix plane to the dimensions of the large ds.imgData texture
  plane = new GL.Mesh.plane();
  
  y_min = 1 - ((textures['full'].height / textures['full'].width) * 2);
  plane.vertices[0][1] = y_min;
  plane.vertices[1][1] = y_min;
  
  plane.compile();
};

gl.ondraw = function() {
  if (!dataReady || !shaders['points'] || !shaders['overview']) {
    //if (!timer) {
      timer = setTimeout("gl.ondraw()", 300);
    //}
    return;
  }
  
  if (!texturesCreated) {
    createTextures();
  }
  
  gl.clearColor(1.0, 1.0, 1.0, 1.0);
  gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
  
  gl.enable(gl.DEPTH_TEST);
  gl.disable(gl.BLEND);
  
  gl.pushMatrix();
  gl.matrixMode(gl.MODELVIEW);
  setZoomPan();
  
  var vertBuffer = [];
  vertBuffer['position'] = ds.buf;
  shaders['points'].uniforms({
    pointSize: 1,
    maxVal: ds.maxVal
  }).drawBuffers(vertBuffer, null, gl.POINTS);
  
  gl.popMatrix();
  
  textures['full'].bind(0);
  shaders['overview'].uniforms({
    texture: 0,
    minVal: y_min
  }).draw(plane);
  textures['full'].unbind(0);  
}

var resizeCanvas = function() {
  gl.viewport(0, 0, gl.canvas.width, gl.canvas.height);
  gl.matrixMode(gl.PROJECTION);
  gl.loadIdentity();
  gl.ortho(0, gl.canvas.width, 0, gl.canvas.height, -100, 100);
  gl.matrixMode(gl.MODELVIEW);
}

// ## Handlers for mouse-interaction
// Handle panning the canvas.
var panX, panY;
var buttons = {};
gl.onmousedown = function(e) {
  buttons[e.which] = true;
  panX = e.x;
  panY = gl.canvas.height - e.y;
  
  screenOffset[0] = -transformOverivewX(panX);
  gl.ondraw();
};


gl.onmousemove = function(e) {
  if (drags(e)) {
    //screenOffset[0] += e.x - panX;
    //screenOffset[1] += (gl.canvas.height - e.y) - panY;
    
    panX = e.x;
    panY = gl.canvas.height - e.y;
    
    screenOffset[0] = -transformOverivewX(panX);
    gl.ondraw();
  }
};

gl.onmouseup = function(e) {
  buttons[e.which] = false;
  
  gl.ondraw();
};

var drags = function(e) {
  for (var b in buttons) {
    if (Object.prototype.hasOwnProperty.call(buttons, b) && buttons[b]) return true;
  }  
};

function main() {
  gl.canvas.id = "webglcanvas";
  document.getElementById("canvas-container").appendChild(gl.canvas);
  
  // set up the viewport
  resizeCanvas();
  
  // Function to handle asynchronous loading and compilation of shaders.
  var loadShaderFromFiles = function(name, opt_vn, opt_fn) {
    var vn = opt_vn || name + '.vs';
    var fn = opt_fn || name + '.fs';
    var shaderDir = 'shaders/';
    var vd, fd;
    $.get(shaderDir + vn, function(data) {
      vd = data;
      if (fd)
        shaders[name] = new GL.Shader(vd, fd);
    });
    $.get(shaderDir + fn, function(data) {
      fd = data;
      if (vd)
        shaders[name] = new GL.Shader(vd, fd);
    });
  };
  
  loadShaderFromFiles("points");
  loadShaderFromFiles("overview");
  
  $.get("readBreadthMedSmall.csv", parseFile);
  
  gl.ondraw();
};