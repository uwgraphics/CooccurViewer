attribute vec3 position;

uniform float pointSize;
uniform float windowSize;
uniform float maxVal;

varying vec4 vColor;

void main() {
	gl_Position = gl_ModelViewProjectionMatrix * vec4((position.x + position.y - (windowSize / 2.0)), position.x, -1.0, 1.0);
	gl_PointSize = pointSize;
	
	vColor = vec4(position.z / maxVal, 0.0, 0.0, 1.0);
}