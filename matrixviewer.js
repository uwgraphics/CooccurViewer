var gl = GL.create();

window.onload = main;

var dataReady = false;
var timer = null;

var shaders = [];
var textures = [];

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
  ds.imgData = new Uint8Array(Math.min(8192, ds.numPos) * ds.numWindow * 4);
  
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
  
  // do another pass-through for the imgData array 
  // (truncate to 0-255 for Uint8 array; maxWidth is 8196, so avg)
  for (var i = 0; i < ds.data.length; i = i + 2) {
    if (i + 1 >= ds.data.length) {
      ds.imgData[(i / 2) * 4] = Math.floor(255 * (ds.data[i][2] / ds.maxVal));
    } else {
      ds.imgData[(i / 2) * 4] = 
        (
          Math.floor(255 * (ds.data[i][2] / ds.maxVal)) + 
          Math.floor(255 * (ds.data[i+1][2] / ds.maxVal))
        ) / 2;
    }
    
    // set alpha to 1 (necessary? could handle this in shader)
    ds.imgData[(i / 2) * 4 + 3] = 1.0;
  }
  
  // compile the GPU data buffer
  ds.buf = new GL.Buffer(gl.ARRAY_BUFFER, Float32Array);
  ds.buf.data = ds.data;
  ds.buf.compile(gl.STATIC_DRAW);
  
  dataReady = true;
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

var texturesCreated = false;
var createTextures = function() {

  var mipmapOpts = {
    magFilter: gl.LINEAR,
    minFilter: gl.LINEAR_MIPMAP_NEAREST,
    format:    gl.RGBA,
    type:      gl.UNSIGNED_BYTE
  };
  
  var pot_width  = Math.min(8192, Math.pow(2, Math.ceil(Math.log(ds.numPos) / Math.log(2))));
  var pot_height = Math.min(8192, Math.pow(2, Math.ceil(Math.log(ds.numWindow) / Math.log(2))));
  
  // gotta make the texture from 'scratch'
  textures['full'] = new GL.Texture(pot_width, pot_height, mipmapOpts);
  
  gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, Math.min(8192, ds.numPos), ds.numWindow, textures['full'].format, textures['full'].type, ds.imgData);
  gl.generateMipmap(gl.TEXTURE_2D);
  
  // clean up state
  gl.bindTexture(gl.TEXTURE_2D, null);
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
  
  // fix plane to the dimensions of the large ds.imgData texture
  var plane = new GL.Mesh.plane();
  y_min = 1 - ((textures['full'].height / textures['full'].width) * 2);
  plane.vertices[0][1] = y_min;
  plane.vertices[1][1] = y_min;
  plane.compile();
  
  textures['full'].bind(0);
  shaders['overview'].uniforms({
    texture: 0
  }).draw(plane);
  textures['full'].unbind(0);  
  
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
}

var resizeCanvas = function() {
  gl.viewport(0, 0, gl.canvas.width, gl.canvas.height);
  gl.matrixMode(gl.PROJECTION);
  gl.loadIdentity();
  gl.ortho(0, gl.canvas.width, 0, gl.canvas.height, -100, 100);
  gl.matrixMode(gl.MODELVIEW);
}

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
  
  $.get("readBreadthAll.csv", parseFile);
  
  gl.ondraw();
};