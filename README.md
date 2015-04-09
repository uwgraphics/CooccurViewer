# CooccurViewer

This project is a prototype implementation of the co-occurrence system presented in the under-review work for a potential publication.  

![The D3-based Co-occurrence viewer for the SIV dataset](https://raw.githubusercontent.com/uwgraphics/CooccurViewer/master/img/cooccur-teaser.png)

The project seeks to expose correlation of observations made between any pair of events in a data sequence. In this project, we present two methods for identifying interesting co-occurrences (see the associated publication for a more in-depth discussion).  

The first is a matrix-based approach (`index.html` in the root folder).  This is a WebGL-based approach for showing all correlations in the full pairwise correlation space.  Please note that your current configuration must support WebGL for this implementation to work; see [WebGL Report](http://webglreport.com/) for details.

The second is a more guided, explicit approach (`d3viewer.html` in the root folder).  This is a [D3](http://d3js.org)-based approach that uses thresholds of particular criteria to filter the data down to managable size.  A demo is availble of the two approaches through [the project website](http://graphics.cs.wisc.edu/Vis/Co-occur/).

### Documentation

In order to generate the data for the application, one must parse a [SAM file](http://samtools.github.io/) into binary file for consumption by the visualization.  A Java program within the `preprocess/` directory contains this program, as well as methods for building (`compile.sh`) and executing the program (`runMetric.sh`).  The program has built-in parameter checking and a help screen, copied below:

	usage: CoOccurLibrary [-d </path/to/outputDir/>] -f <FILE.sam> [-h] -n
		   <reads> -p <positions> [-r <ref.fa>] [-w <window>]

	Parses a given SAM file into a metric that can be used by the MatrixViewer
	visualization. See more information at <URL>
	 -d,--outputDir </path/to/outputDir/>   Directory to dump output files
	 -f,--inputSAM <FILE.sam>               The SAM file to process
	 -h,--help                              Prints this help sheet
	 -n,--numReads <reads>                  The number of reads to expect (run
											`wc -l <FILE.sam>` to estimate;
											necessary for memory allocation)
	 -p,--numPositions <positions>          The number of positions to expect
											(overestimate by reading number of
											lines in FILE.sam)
	 -r,--inputReference <ref.fa>           Sets the reference to the sequence
											found in the given file.
	 -w,--windowSize <window>               The number of positions around
											every positions to check for
											correlation (default 300)

	Please direct any questions to Alper Sarikaya ([email]).

Once the output data directory is generated, copy the directory and its contents to the `data/` directory in the visualization.  To let the vis know that additional data is available, ammend the `definedData.json` file in the root to point to the relevant data files.  Define a named top-level object with the name of the data directory (e.g. **SIV**), and then the required data as below, at minimum. 

```javascript
"SIV": {
	"attenuation": "readBreadth.dat",
	"metrics": [ "conjProbDiff.dat" ],
	"variantCounts": "variantCounts.dat",
}
```

Start a local webserver (e.g. `python -m SimpleHTTPServer`), navigate to the appropriate visualization (e.g. `127.0.0.1:8000/d3viewer.html`), and select the desired dataset from the blue dropdown at the top.

### Libraries used

These implementations use a multitude of libraries to help it go.  Below is a list of the libraries used, their licenses, and how they are used in the system.

* [**Bootstrap**](http://getbootstrap.com) (MIT) -- Used to style and organize UI components on the page, including modal windows.
* [**Bootstrap-submenu**](https://github.com/vsn4ik/bootstrap-submenu) (MIT) -- Used to enable submenus for Bootstrap 3.0 (for dataset hierarchies)
* [**jQuery**](http://jquery.com) (MIT) -- Used to support Bootstrap and provide event listeners for mouse
* [**jQuery UI**](http://jqueryui.com/) (MIT) -- Supports the operation of sliders
* [**jquery-mousewheel**](https://github.com/brandonaaron/jquery-mousewheel) (MIT) -- Adds normalized support for mousewheel events (zooming on canvas)
* [**Hashable.js**](https://github.com/shawnbot/hashable) (none?) -- Adds support for parsing/updating the URL hash to save current viewing state
* [**lightgl.js**](https://github.com/evanw/lightgl.js/) (MIT?) -- Provides a nice abstraction layer for doing low-level WebGL commands (e.g. drawing to texture, managing shaders, binding textures)


### Contact

Please contact [Alper Sarikaya](http://cs.wisc.edu/~sarikaya) with any comments or questions, or feel free to open an issue or pull request.
