varying vec2 coord;

uniform float minVal;

void main() {
	coord = (gl_Vertex.xy - vec2(-1.0, minVal)) / (1.0 - vec2(-1.0, minVal));
	gl_Position = vec4(gl_Vertex.xyz, 1.0);
}
