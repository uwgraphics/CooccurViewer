attribute vec3 position;

uniform float pointSize;
uniform float minVal;
uniform float maxVal;

uniform float rampTexWidth;
uniform float numSteps;
uniform sampler2D colorRamp;

varying vec4 vColor;

vec4 getColorFromColorRamp() {
	// figure out where in the ramp we are 
	float cbIndex = floor(((position.z - minVal) / (maxVal - minVal)) * numSteps);
	
	// get the color from the texture (clamp to range [0,1])
	float yCoord = floor(cbIndex / rampTexWidth) / rampTexWidth;
	float xCoord = floor(mod(cbIndex, rampTexWidth)) / rampTexWidth;
	
	return texture2D(colorRamp, vec2(xCoord, yCoord) + vec2(0.03));
}

void main() {
	gl_Position = gl_ModelViewProjectionMatrix * vec4(position.xy, 0.0, 1.0);
	gl_PointSize = pointSize;
	
	vColor = getColorFromColorRamp();
}
