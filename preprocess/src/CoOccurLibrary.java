import java.io.BufferedReader;
import java.io.File;
import java.io.FileReader;
import java.io.DataOutputStream;
import java.io.FileNotFoundException;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.PrintWriter;
import java.nio.file.Files;
import java.nio.file.Paths;
import java.text.DecimalFormat;
import java.util.*;

import org.apache.commons.cli.*;
import org.apache.commons.math3.stat.inference.*;

public class CoOccurLibrary {

	/**
	 * 
	 */
	private static final long serialVersionUID = 4796941246261175263L;
	
	// explicit 'enums' for parts of a SAM data line
	final static int QNAME = 0;     // query template name
	final static int FLAG = 1;      // notification flags (data is continued, etc.)
	final static int RNAME = 2;     // reference sequence name of alignment
	final static int POS = 3;       // 1-index leftmost position of first base
	final static int MAPQ = 4;      // mapping quality [-10 log_10 Pr(pos is wrong)]
	final static int CIGAR = 5;     // CIGAR string (???)
	final static int RNEXT = 6;     // reference sequence name of next read alignment (* means no next alignment)
	final static int PNEXT = 7;     // position of RNEXT read in (n/a if RNEXT = *)
	final static int TLEN = 8;      // observed template length (0 for single-segment template)
	final static int SEQ = 9;       // the segment sequence (matches functions in CIGAR [?])
	final static int QUAL = 10;     // ASCII of quality score plus 33
	
	//final static String INPUT_SAM_FILE = "../data/sampledata.sam";
    // "../data/SHFVkrc1_RC06 mapping.sam";
    static String INPUT_SAM_FILE = "../data/VHA4_SHA_P11_F21_DPI3_R1_I18_C21.sam"; // sam data file
	static String OUTPUT_DIRECTORY = "../data/H5N1_VHA4_SHA-data/"; // all output files go here

	static String REFERENCE_FA_FILE = ""; // the reference file to use (if blank, use modal sequence)
	static int refOffset = 0; // the offset with which to modify the reference relative to the given SAM file

	static int numPos = 2500; // maximum number of positions to keep track of (SHFV has 16000, SHIV has 12000)
	static int numReads = 258000; // maximum number of reads to keep track of (SHFV has 122890, SHIV has 973000)
	static int windowSize = 300; // window size around (+/-) position of interest to track co-occurences

	static char bases[] = {'A', 'T', 'C', 'G'};

	static HashMap<String, Integer> names = new HashMap<String, Integer>(); 
	static int nextAvailIndex = 0;
	
	static enum CooccurMetric { CONJ_PROB, DIFF_FROM_EXPECTED, RATIO_OF_OBSERVED_TO_EXPECTED, 
			OUTLIER_DIFF_FROM_EXPECTED, GATED_DIFF_FROM_EXPECTED, MUTUAL_INFORMATION };
	
	static int[] givenConsensus; // hold the specified consensus.
	static int[] modalConsensus; // holds the modal consensus.
	static double[] variantProbabilities; // holds the variant probabilities at each position i
	static double[][] readConjProbabilities; // holds the cooccurence variants at j given variants at i
	
	static int[][][] variantCounts; // for every overlapping i,j, counts in the 2x2 matrix (mm, mv, vm, vv)
	static int[][] baseCounts;       // for every position, count the bases (A, T, C, G)
	
	static Map<PosPair, Map<CooccuringBases, Integer>> cooccurCounts; // for every overlapping i,j, count the 4x4 matrix (A,C,T,G for each pos)

	static double[] cooccurenceMetric; // holds the 1D metric of cooccurence
	static double maxCooccurMetric; // holds the maximum value of above
	static double minCooccurMetric; // holds the minimum value of above
	
	static float[][] readDistribution; // the distribution of reads at each position
	static int[] readDepth; // the read depth at every position
	static double[][] readCounts; // the counts of each base for every position (readCounts[i][n] / readDepth[i] = distribution) 
	static int[][] readBreadth; // the count of how many reads span from pos i to pos j
	static int maxValue;
	static int maxPosition;

	static List<SingleRead> reads;
	
	static int actualReads = 0;

	public static void main(String[] args) {
		parseArgs(args);
		setup();
	}

	// use apache commons CLI
	public static void parseArgs(String[] args) { 
		OptionGroup needHelp = new OptionGroup();
		needHelp.addOption(OptionBuilder.withLongOpt("help")
						   .isRequired()
						   .create('h'));

		Options options = new Options();
		//options.isRequired();
		options.addOption(OptionBuilder.withLongOpt("help")
					.withDescription("Prints this help sheet")
					.create('h'));

		options.addOption(OptionBuilder.withLongOpt("inputSAM")
					.withDescription("The SAM file to process")
					.hasArg()
					.withArgName("FILE.sam")
					.isRequired()
					.create('f'));
		
		options.addOption(OptionBuilder.withLongOpt("outputDir")
					.withDescription("Directory to dump output files")
					.hasArg()
					.withArgName("/path/to/outputDir/")
					.create('d'));

		options.addOption(OptionBuilder.withLongOpt("numReads")
					.withDescription("The number of reads to expect (run `wc -l <FILE.sam>` to estimate; necessary for memory allocation)")
					.hasArg()
					.withArgName("reads")
					.isRequired()
					.create('n'));
		
		options.addOption(OptionBuilder.withLongOpt("numPositions")
					.withDescription("The number of positions to expect (overestimate by reading number of lines in FILE.sam)")
					.hasArg()
					.withArgName("positions")
					.isRequired()
					.create('p'));

		options.addOption(OptionBuilder.withLongOpt("windowSize")
					.withDescription("The number of positions around every positions to check for correlation (default 300)")
					.hasArg()
					.withArgName("window")
					.create('w'));
		
		options.addOption(OptionBuilder.withLongOpt("inputReference")
					.withDescription("Sets the reference to the sequence found in the given file.")
					.hasArg()
					.withArgName("ref.fa")
					.create('r'));

		// actually do something with the arguments now
		CommandLineParser parser = new BasicParser();
		Options help = new Options();
		help.addOptionGroup(needHelp);

		Options opts = options;
		try {
			CommandLine cl = parser.parse(help, args, true);

			if (cl.hasOption('h')) {
				printHelp(opts);
				System.exit(0);
			}

			cl = parser.parse(opts, args);

			// set required properties
			INPUT_SAM_FILE = cl.getOptionValue('f');
			if (cl.hasOption('d')) {
				OUTPUT_DIRECTORY = cl.getOptionValue('d');
				if (OUTPUT_DIRECTORY.charAt(OUTPUT_DIRECTORY.length() - 1) != '/')
					OUTPUT_DIRECTORY += '/';
			} else {
				// output into the directory where the same file is
				if (INPUT_SAM_FILE.indexOf('/') == -1)
					OUTPUT_DIRECTORY = "./";
				else {
					int dirLimit = INPUT_SAM_FILE.lastIndexOf('/');
					OUTPUT_DIRECTORY = INPUT_SAM_FILE.substring(0, dirLimit + 1);
				}						
			}

			if (cl.hasOption('r')) {
				REFERENCE_FA_FILE = cl.getOptionValue('r');
				if (Files.notExists(Paths.get(REFERENCE_FA_FILE)))
					throw new ParseException("Given reference file '" + REFERENCE_FA_FILE + "' does not exist");
			}

			// check the existence of input file and output directory
			if (!Files.isDirectory(Paths.get(OUTPUT_DIRECTORY)))
				throw new ParseException("Given output directory '" + OUTPUT_DIRECTORY + "' does not exist");

			if (Files.notExists(Paths.get(INPUT_SAM_FILE)))
				throw new ParseException("Given input SAM file '" + INPUT_SAM_FILE + "' does not exist");

			// check that -n and -p are integers
			try {
				numPos = Integer.parseInt(cl.getOptionValue('p'));
			} catch (NumberFormatException e) {
				throw new ParseException("-p was passed a non-integer value: " + cl.getOptionValue('p'));
			}	

			try {
				numReads = Integer.parseInt(cl.getOptionValue('n'));
			} catch (NumberFormatException e) {
				throw new ParseException("-n was passed a non-integer value: " + cl.getOptionValue('n'));
			}

			// now actually parse the reference (now that we know how many positions there are)
			if (cl.hasOption('r')) 
				parseFAReferenceFile();

			// handle -w
			if (cl.hasOption('w')) {
				try {
					windowSize = Integer.parseInt(cl.getOptionValue('w'));
				} catch (NumberFormatException e) {
					throw new ParseException("-w was passed a non-integer value: " + cl.getOptionValue('w'));
				}
			}

		} catch (ParseException exp) {
			System.err.println("Argument parsing failed. " + exp.getMessage());
			System.out.println();

			printHelp(opts);
			System.exit(-1);
		}
	}

	private static void printHelp(Options opts) {
		HelpFormatter formatter = new HelpFormatter();
		String header = "\nParses a given SAM file into a metric that can be used by the MatrixViewer visualization. See more information at http://graphics.wisc.edu/Vis/Co-occur/\n";
		String footer = "\nPlease direct any questions to Alper Sarikaya (sarikaya@cs.wisc.edu).";
		formatter.printHelp("CoOccurLibrary", header, opts, footer, true);
	}

	public static void setup() {
		// defaults to filling with zeros; see 
		// http://docs.oracle.com/javase/specs/jls/se7/html/jls-4.html#jls-4.12.5
		reads = new ArrayList<SingleRead>(numReads);

		// print out information
		System.out.println("parsing input file " + INPUT_SAM_FILE + " to " + OUTPUT_DIRECTORY);
		
		if (REFERENCE_FA_FILE == "")
			System.out.println("\tusing no reference file (falling back to modal consensus!)");
		else
			System.out.println("\tusing reference file " + REFERENCE_FA_FILE);
		
		System.out.println("parsing approx " + numReads + " reads to " + numPos + " positions with a window of " + windowSize + " around each position");

		DecimalFormat df = new DecimalFormat("0.00");
		long startTime, endTime;
		System.out.print("parsing SAM file took ... ");
		startTime = System.nanoTime();
		parseSAM();
		endTime = System.nanoTime();
		System.out.println(df.format((endTime - startTime) / 1e9) + " seconds");
		
		// unused right now..
		// populateAllReads();

		doReadBreadth();
		// do a test run; just calculate read depth at every position
		dumpConjProbabilities(CooccurMetric.DIFF_FROM_EXPECTED, true);
		//dumpConjProbabilities(CooccurMetric.RATIO_OF_OBSERVED_TO_EXPECTED, true);
		//dumpConjProbabilities(CooccurMetric.OUTLIER_DIFF_FROM_EXPECTED, true);
		//dumpConjProbabilities(CooccurMetric.GATED_DIFF_FROM_EXPECTED, true);
		//drawConjProbabilities();
		
		//getReadDepth();
		// doReadDiversity();
	}

	static void parseFAReferenceFile() {
		String line = "";
		int counter = 0;

		givenConsensus = new int[numPos];

		// fill with -1 to signify those positions that have no data attached
		// (0 already has a special meaning)
		Arrays.fill(givenConsensus, -1);

		try {
			BufferedReader reader = new BufferedReader(new FileReader(new File(REFERENCE_FA_FILE)));
			while (line != null) {
				line = reader.readLine();
				if (line != null) {
					if (line.startsWith(">"))
						continue;

					line = line.trim();
					for (int i = 0; i < line.length(); i++) {
						givenConsensus[counter] = SingleRead.bpToIndex(line.charAt(i));
						counter++;
					}
				}
			}
		} catch (IOException e) { 
			e.printStackTrace();
		}

		System.out.println("successfully parsed " + counter + " positions of reference.");
	}

	static int setHeaderFlags(boolean isSparse, boolean isInt, int precisionBytes, int spacing) {
		// do some bounds checking
		if (spacing > 4 || spacing <= 0) {
			System.err.println("expecting spacing to be between 1 and 4");
			spacing = Math.max(0, Math.min(4, spacing));
		}

		if (precisionBytes > 4 || precisionBytes <= 0) {
			System.err.println("expecting precision to be between 1-4 (0 reserved for floats)");
			precisionBytes = Math.max(1, Math.min(4, precisionBytes));
		}

		int base = isSparse ? 32 : 0;
		base |= isInt ? 16 : 0;
		base |= (precisionBytes - 1) << 2;
		base |= (spacing - 1);

		return base;
	} 
	
	static void doReadDiversity() {
		DecimalFormat df = new DecimalFormat("0.00");
		long startTime, endTime;
		
		System.out.print("getting read counts took ... ");
		startTime = System.nanoTime();
		getReadCounts();
		endTime = System.nanoTime();
		System.out.println(df.format((endTime - startTime) / 1e9) + " seconds");
		
		System.out.print("getting every co-occurrence statistic took ... ");
		startTime = System.nanoTime();
		getReadDiversity();
		endTime = System.nanoTime();
		System.out.println(df.format((endTime - startTime) / 1e9) + " seconds");
	}
	
	static void doReadBreadth() {
		doReadBreadth(true);
	}

	static void getReadBreadth() {
		readBreadth = new int[numPos][numPos];
		actualReads = 0;
		
		for (int i = 0; i < reads.size(); i++) {
			SingleRead curRead = reads.get(i);
			if (curRead == null) break;
			
			for (int k = curRead.startPos; k < (curRead.startPos + curRead.length); k++) {
				for (int n = curRead.startPos; n < (curRead.startPos + curRead.length); n++) {
					if (++readBreadth[k][n] > maxValue) {
						maxValue = readBreadth[k][n];
					}
				}
				
				if (k > maxPosition) maxPosition = k;
			}
			
			actualReads++;
		}
	}
	
	static void doReadBreadth(boolean writeBinary) {
		getReadBreadth();
		
		// dump to file
		if (writeBinary) {
			try {
				String outputFile = OUTPUT_DIRECTORY + "readBreadth.dat";
				System.out.print("writing to " + outputFile + " ...");
				
				DataOutputStream os = new DataOutputStream(new FileOutputStream(outputFile));
				os.writeInt(2 * windowSize + 1); // number of items around a position (numWindow)
				os.writeInt(numPos);             // number of positions captured
				os.writeInt(setHeaderFlags(false, false, 0, 1));
				
				for (int i = 0; i < numPos; i++) {
					for (int dj = -windowSize; dj <= windowSize; dj++) {
						int j = i + dj;
						if (j < 0 || j >= numPos) {
							os.writeFloat(0);
						} else {
							os.writeFloat((float)readBreadth[i][j]);
						}
					}
				}
				
				os.flush();
				os.close();
				
				System.out.println(" finished.");
			} catch (FileNotFoundException e) {
				e.printStackTrace();
			} catch (IOException e) {
				e.printStackTrace();
			}
		} else {
			try {
				PrintWriter file = new PrintWriter("../../data/readBreadth.csv");
				for (int i = 0; i < maxPosition; i++) {
					for (int j = -150; j < 150; j++) {
						int reqIndex = i + j;
						if (reqIndex < 0) {
							file.print("0,");
						} else {
							file.print(readBreadth[i][reqIndex] + ",");
						}
					}
					file.print(readBreadth[i][i+150]);
					file.println();
				}
			
				file.flush();
				file.close();
			} catch (IOException e) {
				e.printStackTrace();
			}
		}
	}
	
	static void getReadDiversity() {
		// hold the minimum read that starts at the current position i
		int minReadPos = 0;
		cooccurenceMetric = new double[numPos];
		
		minCooccurMetric = Double.MAX_VALUE;
		maxCooccurMetric = Double.MIN_VALUE;
		
		// for each position i, separate into four categories
		for (int i = 0; i < numPos; i++) {
			int numReadsAtThisPos = 0;
			Map<Character, ArrayList<SingleRead>> categories = new HashMap<Character, ArrayList<SingleRead>>();
			
			for (int n = minReadPos; n < reads.size(); n++) {
				SingleRead curRead = reads.get(n);
				
				// if we're out of reads, break out of this collection loop
				if (curRead == null) break;
				
				// if the current read doesn't even start at the current i, break and continue 
				// (instead of iterating through all reads)
				if (curRead.startPos > i) break;
				
				// if the current read doesn't even reach the current i with its lastpos + window, 
				// increase minReadPos for subsequent iterations of i
				if (curRead.lastPos() + windowSize < i) 
					minReadPos = n;
				
				// if the current read doesn't span to i with its lastpos, continue
				if (curRead.lastPos() < i) continue;
				
				char thisReadBase = curRead.getReadAtAbsolutePos(i);
				if (!categories.containsKey(thisReadBase)) {
					ArrayList<SingleRead> newList = new ArrayList<SingleRead>();
					categories.put(thisReadBase, newList);
				}
				
				categories.get(thisReadBase).add(curRead);
				numReadsAtThisPos++;
			}
			
			// no more read positions to do!
			if (numReadsAtThisPos == 0) return;
			
			// now that we've categorized-up each read at i, 
			// start stepping through each subsequent read j (within read-length window)
			int numSamples = 0;
			for (int j = Math.max(0, i - windowSize); j < (i + windowSize); j++) {
				
				// iterate through each i-category
				for (Map.Entry<Character, ArrayList<SingleRead>> category : categories.entrySet()) {
					int catIndex = SingleRead.bpToIndex(category.getKey());
					
					int coverage = 0;
					long[] baseCoverage = new long[4];
					
					// iterate through each read that matches this i-category
					for (SingleRead curRead : category.getValue()) {
						// skip over those entries that don't span this j-th entry
						if (!curRead.overlaps(j)) continue;
						
						baseCoverage[SingleRead.bpToIndex(curRead.getReadAtAbsolutePos(j))]++;
						coverage++;
					}
					
					// if there is no overlap between the specific read at i and j, continue
					if (baseCoverage[0] == 0 && baseCoverage[1] == 0 && 
							baseCoverage[2] == 0 && baseCoverage[3] == 0) 
						continue;
				
					System.out.format("Comparing pos %3d to pos %3d; ", i, j);
					cooccurenceMetric[i] += getChiSquaredDiff(readCounts[j], baseCoverage);
					numSamples++;
				}
			}
			
			// normalize by the 4 * number of j-s that we encountered (logical?)
			assert(numSamples != 0);
			cooccurenceMetric[i] /= numSamples;
			
			maxCooccurMetric = Math.max(maxCooccurMetric, cooccurenceMetric[i]);
			minCooccurMetric = Math.min(minCooccurMetric, cooccurenceMetric[i]);
		}
	}

	static private double getChiSquaredDiff(double[] pop, long[] sample) {
		// if there is any count that is zero, remove it 
		// (as it removes a useless DOF, and chiSquareTest() wants positive counts for the population)
		List<Integer> indicesToRemove = new ArrayList<Integer>();
		for (int i = 0; i < pop.length; i++) {
			if (pop[i] == 0) {
				indicesToRemove.add(i);
			}
		}
		
		if (!indicesToRemove.isEmpty()) {
			double[] tempPop = new double[pop.length - indicesToRemove.size()];
			long[] tempSample = new long[sample.length - indicesToRemove.size()];
			
			int tempCounter = 0;
			for (int i = 0; i < pop.length; i++) {
				if (indicesToRemove.contains(i)) continue;
				
				tempPop[tempCounter] = pop[i];
				tempSample[tempCounter] = sample[i];
				tempCounter++;
			}
			
			pop = tempPop;
			sample = tempSample;
		}
		
		assert(pop.length != 0);
		
		// if only one base is ever seen at this position, a chi-square test doesn't make sense.
		// return 0 as the p-value
		if (pop.length == 1) {
			System.out.println("only one read ever seen at this position j, skipping..");
			return 0.0;
		}
		
		ChiSquareTest test = new ChiSquareTest();
		double pvalue = test.chiSquareTest(pop, sample);
		System.out.format("p-value: %7.6g \n", pvalue);
		
		// try doing something silly, like counting the number of p < 0.05
		double ret = 0.0;
		if (pvalue <= 0.05) {
			ret = 1.0;
		}
		
		return ret;
	}
	
	static private float getChiSquaredDistOld(float[][] pop, float[][] sample) {
		assert(pop.length == sample.length);
		
		float dist = 0.f;
		for (int i = 0; i < pop.length; i++) {
			float[] thisPop = pop[i];
			for (int x = 0; x < thisPop.length; x++) {
				for (int j = 0; j < sample.length; j++) {
					float[] thisSample = sample[i];
					for (int y = 0; y < thisSample.length; y++) {
						float divisor = thisPop[x] + thisSample[y];
						if (divisor == 0.f) continue;
						
						dist += Math.pow(thisPop[x] - thisSample[y], 2) / divisor;
					}
				}
			}
		}
		
		return dist / 2.f;
	}
	
	private static int getRefAtPos(int pos) {
		return REFERENCE_FA_FILE == "" ? modalConsensus[pos] : givenConsensus[pos];
	}
	
	static void getConjProbabilityFromModalConcensus(CooccurMetric metric) {
		modalConsensus = new int[numPos];
		variantProbabilities = new double[numPos];
		readConjProbabilities = new double[numPos][numPos];

		variantCounts = new int[numPos][numPos][4];
		baseCounts = new int[numPos][4];

		cooccurCounts = new HashMap<PosPair, Map<CooccuringBases, Integer>>();
		
		Map<Integer, Map<Character, ArrayList<SingleRead>>> readCategories = new HashMap<Integer, Map<Character, ArrayList<SingleRead>>>();
		int minReadPos = 0;
		
		// get the consensus sequence and collect reads at the same time
		for (int i = 0; i < numPos; i++) {
			int numReadsAtThisPos = 0;
			int[] readCounts = new int[4];
			Map<Character, ArrayList<SingleRead>> curCategories = new HashMap<Character, ArrayList<SingleRead>>();
			
			// collect reads for this position
			for (int n = minReadPos; n < reads.size(); n++) {
				SingleRead curRead = reads.get(n);
				
				if (curRead == null) break;
				if (curRead.startPos > i) break; // TODO: this line assumes that the reads are ordered by startPos
				
				if (curRead.lastPos() + windowSize < i)
					minReadPos = n;
				
				if (curRead.lastPos() < i) continue;
				
				char thisReadBase = curRead.getReadAtAbsolutePos(i);
				if (!curCategories.containsKey(thisReadBase)) {
					ArrayList<SingleRead> newList = new ArrayList<SingleRead>();
					curCategories.put(thisReadBase, newList);
				}
				
				curCategories.get(thisReadBase).add(curRead);
				numReadsAtThisPos++;
				
				readCounts[SingleRead.bpToIndex(thisReadBase)]++;
			}
			
			// discover what is the consensus read at this position
			if (numReadsAtThisPos == 0)
				modalConsensus[i] = -1;
			else {
				readCategories.put(i, curCategories);
				
				int maxCounts = 0; int maxRead = -1; int totalCounts = 0;
				for (int b = 0; b < 4; b++) {
					baseCounts[i][b] = (short)readCounts[b];
					totalCounts += readCounts[b];
					if (readCounts[b] > maxCounts) {
						maxRead = b;
						maxCounts = readCounts[b];
					}
				}
				
				modalConsensus[i] = maxRead;
				
				// calculate the variant probability at this position i
				variantProbabilities[i] = ((double)(totalCounts - maxCounts)) / totalCounts;
			}
		}
		
		// now actually do some calculations
		for (int i = 0; i < numPos; i++) {
			// what's the modal read here?
			// int modalRead = REFERENCE_FA_FILE == "" ? modalConsensus[i] : givenConsensus[i];
			int modalRead = getRefAtPos(i);
			
			// keep track of avg 
			int numOverlaps = 0;
			double sumVals = 0.0;
			
			Map<Character, ArrayList<SingleRead>> thisCategories = readCategories.get(i);

			// skip if no reads at this location
			if (modalRead == -1 || thisCategories == null || thisCategories.isEmpty()) continue;
						
			// now go through every other read j that spans around this i
			for (int j = Math.max(0, i - windowSize); j <= (i + windowSize); j++) {
				int modalReadJ = getRefAtPos(j);
				if (modalReadJ == -1) {
					//System.err.println("no reference found at position " + j);
					continue;
				}
				
				int[][] pairCooccurCounts = new int[4][4];

				// iterate through each i-category (as long as it's not the modal one)
				// double variantsi = 0, variantsij = 0, modals = 0;
				double vari_varj = 0, vari_modalj = 0, modali_varj = 0, modali_modalj = 0; 
				for (Map.Entry<Character, ArrayList<SingleRead>> category : thisCategories.entrySet()) {
					char i_base = category.getKey();

					// check for modality of i; if so, count all reads that span j
					if (bases[modalRead] == i_base) {
						for (SingleRead curRead : category.getValue()) {
							if (!curRead.overlaps(j)) continue;
							
							char j_base = curRead.getReadAtAbsolutePos(j);
							pairCooccurCounts[SingleRead.bpToIndex(i_base)][SingleRead.bpToIndex(j_base)]++;
							if (j_base == bases[getRefAtPos(j)])
								modali_modalj++;
							else
								modali_varj++;
						}
					} else {
						for (SingleRead curRead : category.getValue()) {
							// skip those that don't span j
							if (!curRead.overlaps(j)) continue;
							
							// add to counter based on modality of the jth read
							char j_base = curRead.getReadAtAbsolutePos(j);
							pairCooccurCounts[SingleRead.bpToIndex(i_base)][SingleRead.bpToIndex(j_base)]++;
							if (j_base == bases[getRefAtPos(j)])
								vari_modalj++;
							else
								vari_varj++;
						}
					}
				}

				cooccurCounts.put(new PosPair(i,j), CooccuringBases.createFrom4x4array(pairCooccurCounts));
				
				// add some counts for the 2x2 conjunction matrix
				variantCounts[i][j][0] = (int)modali_modalj;
				variantCounts[i][j][1] = (int)modali_varj;
				variantCounts[i][j][2] = (int)vari_modalj;
				variantCounts[i][j][3] = (int)vari_varj;

				double totalCounts = vari_varj + vari_modalj + modali_varj + modali_modalj;
				
				switch (metric) {
					case DIFF_FROM_EXPECTED:
				    case GATED_DIFF_FROM_EXPECTED:
					case OUTLIER_DIFF_FROM_EXPECTED:
						double vari = vari_modalj + vari_varj;
						double modali = modali_modalj + modali_varj;
						
						if (metric == CooccurMetric.GATED_DIFF_FROM_EXPECTED && 
							vari / (double)totalCounts < 0.05) {
							readConjProbabilities[i][j] = 0.0;
							break;
						}

						double prob_varj_cond_vari = vari == 0.0 ? 0.0 : vari_varj / vari;
						double prob_varj_cond_modali = modali == 0.0 ? 0.0 : modali_varj / modali;
						
						readConjProbabilities[i][j] = prob_varj_cond_vari - prob_varj_cond_modali;
						
						if (metric == CooccurMetric.OUTLIER_DIFF_FROM_EXPECTED) {
							sumVals += readConjProbabilities[i][j];
							numOverlaps++;
						}
						
						break;
					
					case CONJ_PROB:
						double probVariantsI = (vari_modalj + vari_varj) / 1.0 / Math.max(1, totalCounts);
						double probVariantsIJ = vari_varj / 1.0 / Math.max(1, totalCounts);
						
						if (probVariantsI == 0.0) 
							readConjProbabilities[i][j] = 0.0;
						else
							readConjProbabilities[i][j] = probVariantsIJ / probVariantsI;
						break;

					// Mike's metric
					case RATIO_OF_OBSERVED_TO_EXPECTED:
						double probVarIJ = vari_varj / 1.0 / Math.max(1, totalCounts);
						double probVarI = (vari_varj + vari_modalj) / 1.0 / Math.max(1, totalCounts);
						double probVarJ = (vari_varj + modali_varj) / 1.0 / Math.max(1, totalCounts);

						if (probVarI * probVarJ <= 0.0)
							readConjProbabilities[i][j] = 0.0;
						else {
						    double val = Math.log(probVarIJ / (probVarI*probVarJ));
							readConjProbabilities[i][j] = Math.max(-5, Math.min(5, val));
						}
						break;
						
					case MUTUAL_INFORMATION:
						readConjProbabilities[i][j] = 0.0;
						break;
				}
			}
			
			if (metric == CooccurMetric.OUTLIER_DIFF_FROM_EXPECTED) {
				double avg = sumVals / (double)numOverlaps;
				for (int j = Math.max(0, i - windowSize); j < (i + windowSize); j++) {
					if (readConjProbabilities[i][j] != 0.0)
						readConjProbabilities[i][j] = avg - readConjProbabilities[i][j];
				}
			}
		}

		// try doing a little verification here.  
		// the counts at any two positions should be symmetrical.
		Random r = new Random();
		int r_i = r.nextInt(numPos);
		int r_j = r.nextInt(numPos);
		
		while (readBreadth[r_i][r_j] == 0) {
			r_i = r.nextInt(numPos);
			r_j = r.nextInt(numPos);
		}

		int[] m_ij = variantCounts[r_i][r_j];
		int[] m_ji = variantCounts[r_j][r_i];

		System.out.printf("\nComparison of position %d to %d\n", r_i, r_j);
		
		System.out.printf("%4d: %5d, %5d, %5d, %5d --> %6d (depth: %6d)\n", r_i, m_ij[0], m_ij[1], m_ij[2], 
						  m_ij[3], m_ij[0] + m_ij[1] + m_ij[2] + m_ij[3],
						  readBreadth[r_i][r_j]);
		System.out.printf("%4d: %5d, %5d, %5d, %5d --> %6d (depth: %6d)\n", r_j, m_ji[0], m_ji[1], m_ji[2], 
						  m_ji[3], m_ji[0] + m_ji[1] + m_ji[2] + m_ji[3],
						  readBreadth[r_j][r_i]);

		System.out.printf("co-occur counts (%d to %d):\n", r_i, r_j);
//		int[][] pairCounts = cooccurCounts.get(new PosPair(r_i, r_j));
//		for (int n = 0; n < 4; n++) {
//			for (int m = 0; m < 4; m++) {
//				System.out.printf("\t%c (i) -> %c (j): %6d (%5.2f%%)\n", bases[n], bases[m], pairCounts[n][m], pairCounts[n][m] / 1.0 / readBreadth[r_i][r_j] * 100);
//			}
//		}
		
		Map<CooccuringBases, Integer> pairCounts = cooccurCounts.get(new PosPair(r_i, r_j));
		for (Map.Entry<CooccuringBases, Integer> entry : pairCounts.entrySet()) {
			CooccuringBases b = entry.getKey();
			int n = entry.getValue();
			System.out.printf("\t%c (i) -> %c (j): %6d (%5.2f%%)\n", bases[b.i], bases[b.j], n, n / 1.0 / readBreadth[r_i][r_j] * 100);
		}
	}
	
	static void dumpConjProbabilities(CooccurMetric metric) {
		dumpConjProbabilities(metric, true);
	}
	
	static void dumpConjProbabilities(CooccurMetric metric, boolean writeBinary) {
		DecimalFormat df = new DecimalFormat("0.00");
		long startTime, endTime;
		System.out.print("creating conjugate probabilities took ... ");
		startTime = System.nanoTime();
		
		
		getConjProbabilityFromModalConcensus(metric);
		
		endTime = System.nanoTime();
		System.out.println(df.format((endTime - startTime) / 1e9) + " seconds");
		
		startTime = System.nanoTime();
		
		if (writeBinary) {
			try {
				String outputFile = OUTPUT_DIRECTORY;
				switch (metric) {
					case DIFF_FROM_EXPECTED:
						outputFile += "conjProbDiff.dat";
						break;
					case OUTLIER_DIFF_FROM_EXPECTED:
						outputFile += "conjProbDiff-outliers.dat";
						break;
				    case GATED_DIFF_FROM_EXPECTED:
						outputFile += "conjProbDiff-gated05.dat";
						break;
					case RATIO_OF_OBSERVED_TO_EXPECTED: 
						outputFile += "conjProbDiff-ratio.dat";
						break;
					case MUTUAL_INFORMATION:
						outputFile += "mutualInfo.dat";
						break;
					default:
						System.err.println("no file specified, dumping to data.dat");
						break;
				}
				
				System.out.print("writing to " + outputFile + " ...");
				DataOutputStream os = new DataOutputStream(new FileOutputStream(outputFile));
				// write dimensions (two ints, windowSize, numPos)
				os.writeInt(2 * windowSize + 1); // window size (numWindow)
				os.writeInt(numPos);             // number of positions (numPos)
				os.writeInt(setHeaderFlags(false, false, 0, 1));
				
				for (int i = 0; i < numPos; i++) {
					for (int dj = -windowSize; dj <= windowSize; dj++) {
						int j = i + dj;
						if (j < 0 || j >= numPos) {
							os.writeFloat(0);
						} else {
							os.writeFloat((float)readConjProbabilities[i][j]);
						}
					}
				}
				
				os.flush();
				os.close();

				outputFile = OUTPUT_DIRECTORY + "variantCounts.dat";
				System.out.print("writing to " + outputFile + " ...\n");
				os = new DataOutputStream(new FileOutputStream(outputFile));
				
				// write dimensions
				os.writeInt(2 * windowSize + 1);
				os.writeInt(numPos);
				os.writeInt(setHeaderFlags(true, true, 4, 4));

				for (int i = 0; i < numPos; i++) {
					for (int dj = -windowSize; dj <= windowSize; dj++) {
						int j = i + dj;
						
						if (j < 0 || j >= numPos)
							continue;
						
						// if there's no information here, skip it
						int[] curVal = variantCounts[i][j];
						if (curVal[0] + curVal[1] + curVal[2] + curVal[3] == 0) 
							continue;

						// dump the absolute index so we can store a sparse representation
						os.writeInt(i * (windowSize * 2 + 1) + (dj + windowSize));
						
						for (int n = 0; n < 4; n++) {
							os.writeInt(curVal[n]);
						}
					}
				}

				os.flush();
				os.close();

				outputFile = OUTPUT_DIRECTORY + "baseCounts.dat";
				System.out.print("writing to " + outputFile + " ... \n");
				os = new DataOutputStream(new FileOutputStream(outputFile));

				// write dimensions
				os.writeInt(1);
				os.writeInt(numPos);
				os.writeInt(setHeaderFlags(true, true, 4, 1));

				for (int i = 0; i < numPos; i++) {
					int[] curVal = baseCounts[i];

					if (curVal[0] + curVal[1] + curVal[2] + curVal[3] == 0) 
						continue;
					
					// dump the absolute index so we can store a sparse representation
					os.writeInt(i);
					
					for (int n = 0; n < 4; n++) {
						os.writeInt(curVal[n]);
					}
				}

				os.flush();
				os.close();
				
				// dump 4x4 matrix as well (??)
				outputFile = OUTPUT_DIRECTORY + "fullCounts.dat";
				System.out.print("writing to " + outputFile + " ... \n");
				os = new DataOutputStream(new FileOutputStream(outputFile));
				
				// write dimensions
				os.writeInt(2 * windowSize + 1);
				os.writeInt(numPos);
				os.writeInt(setHeaderFlags(true, true, 4, 4));
				
				// ... we'll see how this works
				for (Map.Entry<PosPair, Map<CooccuringBases, Integer>> pos : cooccurCounts.entrySet()) {
					int i = pos.getKey().i;
					int j = pos.getKey().j;
					int absIndex = i * (windowSize * 2 + 1) + (j - i + windowSize);
					os.writeInt(absIndex);
					
					os.writeByte(pos.getValue().size());
					for (Map.Entry<CooccuringBases, Integer> counts : pos.getValue().entrySet()) {
						os.writeByte(counts.getKey().baseByte());
						os.writeInt(counts.getValue());
					}
				}
				
				os.flush();
				os.close();

			 } catch (FileNotFoundException e) {
				e.printStackTrace();
			} catch (IOException e) {
				e.printStackTrace();
			}
		} else {
			try {
				String outputFile = OUTPUT_DIRECTORY;
				switch (metric) {
					case DIFF_FROM_EXPECTED:
						outputFile += "conjProbDiff.csv";
						break;
					case OUTLIER_DIFF_FROM_EXPECTED:
						outputFile += "conjProbDiff-outliers.csv";
						break;
				    case GATED_DIFF_FROM_EXPECTED:
						outputFile += "conjProbDiff-gated10.csv";
						break;
					case RATIO_OF_OBSERVED_TO_EXPECTED: 
						outputFile += "conjProbDiff-ratio.csv";
						break;
					case MUTUAL_INFORMATION:
						outputFile += "mutualInfo.csv";
						break;
					default:
						System.err.println("no file specified, dumping to data.dat");
						break;
				}

				System.out.print("writing to " + outputFile + " ...");
				PrintWriter file = new PrintWriter(outputFile);
				for (int i = 0; i < numPos; i++) {
					for (int dj = -windowSize; dj < windowSize; dj++) {
						int j = i + dj;
						if (j < 0 || j >= numPos) {
							file.print("0,");
						} else {
							file.print(readConjProbabilities[i][j] + ",");
						}
					}
				
					if (i + windowSize >= numPos) {
						file.print("0");
					} else {
						file.print(readConjProbabilities[i][i + windowSize]);
					}
				
					file.println();
				}
			
				file.flush();
				file.close();
				
				
				outputFile = OUTPUT_DIRECTORY + "variantCounts.csv";
				System.out.print("writing to " + outputFile + " ... ");
				file = new PrintWriter(outputFile);
				for (int i = 0; i < numPos; i++) {
					for (int dj = -windowSize; dj < windowSize; dj++) {
						int j = i + dj;
						
						if (j < 0 || j >= numPos)
							continue;
						
						file.print("(" + i + "," + j + "):");
						int[] curVal = variantCounts[i][j];
						for (int n = 0; n < 3; n++)
							file.print(curVal[n] + ",");
						
						file.println(curVal[3]);
					}
				}
				
				file.flush();
				file.close();
				
				outputFile = OUTPUT_DIRECTORY + "baseCounts.csv";
				System.out.print("writing to " + outputFile + " ... ");
				file = new PrintWriter(outputFile);
				for (int i = 0; i < numPos; i++) {
					for (int n = 0; n < 3; n++)
						file.print(baseCounts[i][n] + ",");
					
					file.println(baseCounts[i][3]);
				}
				
				file.flush();
				file.close();
				
			} catch (IOException e) {
				e.printStackTrace();
			}
		}
		
		endTime = System.nanoTime();
		System.out.println(df.format((endTime - startTime) / 1e9) + " seconds");
		
		//drawCooccurrenceMetric();
	}
	
	/* REMOVE PROCESSING CODE
	void drawCooccurrenceMetric() {
		float[][] colorRamp = {{5, 48, 97}, {33, 102, 172}, {67, 147, 195}, {146, 197, 222}, {209, 229, 240}, 
							   {247, 247, 247}, 
							   {253, 219, 199}, {244, 165, 130}, {214, 96, 77}, {178, 24, 43}, {103, 0, 31}};
		
		String imgPath = "../../data/diff_from_expected.png";
		DecimalFormat df = new DecimalFormat("0.00");
		long startTime = System.nanoTime();
		System.out.print("saving image to file " + imgPath + " took... ");
		
		size(numPos, numPos);
		noStroke();
		
		double minVal = -1.0;
		double maxVal = 1.0;
		
		for (int i = 0; i < numPos; i++) {
			for (int j = 0; j < numPos; j++) {
				// get the color 
				double curVal = readConjProbabilities[i][j];
				int rampIndex = colorRamp.length / 2 + 1;
				if (curVal <= minVal)
					rampIndex = 0;
				else if (curVal >= maxVal) 
					rampIndex = colorRamp.length - 1;
				else
					rampIndex = (int) (Math.floor((curVal - minVal) / (maxVal - minVal) * (colorRamp.length - 2)) + 1);
				
				fill(colorRamp[rampIndex][0], colorRamp[rampIndex][1], colorRamp[rampIndex][2]);
				rect(i, j, 1, 1);
			}
		}
		
		save(dataPath(imgPath));
		
		long endTime = System.nanoTime();
		System.out.println(df.format((endTime - startTime) / 1e9) + " seconds");
	}
	
	void drawConjProbabilities() {
		size(numPos, numPos);
		noStroke();
		
		for (int i = 0; i < numPos; i++) {
			for (int j = 0; j < numPos; j++) {
				fill((float)(255.f * readConjProbabilities[i][j]), 0.f, 0.f);
				rect(i, j, 1, 1);
			}
		}
		
		save(dataPath("../../data/conProb.png"));
	}
	*/

	static void getReadCounts() {
		actualReads = 0;
		readDepth = new int[numPos];
		readCounts = new double[numPos][4];
		
		// add up counts
		for (int i = 0; i < reads.size(); i++) {
			SingleRead thisRead = reads.get(i);
			if (thisRead == null) break;

			char[] reads = thisRead.reads;
			for (int n = 0; n < reads.length; n++) {
				int curPos = thisRead.startPos + n;
				readDepth[curPos]++;
				readCounts[curPos][SingleRead.bpToIndex(reads[n])]++;
			}
			
			actualReads++;
		}
	}
	
	static void getReadDistribution() {
		int[] depth = new int[numPos];
		readDistribution = new float[numPos][4];
		
		// based on the current read position, this variable holds the index of the first read that could overlap
		for (int i = 0; i < reads.size(); i++) {
			SingleRead curRead = reads.get(i);
			if (curRead == null) break;
			
			char[] curReads = curRead.reads;
			for (int n = 0; n < curReads.length; n++) {
				int curPos = curRead.startPos + n;
				readDistribution[curPos][SingleRead.bpToIndex(curReads[n])] += 1.f;
				depth[curPos]++;
			}
		}
		
		for (int i = 0; i < numPos; i++) {
			// if the depth is none, we've reached the end position
			if (depth[i] == 0) break;
			
			for (int j = 0; j < 4; j++) {
				readDistribution[i][j] /= depth[i];
			}
		}
	}

	static void populateAllReads() {
		int maxReadLength = 300;
		for (int i = 0; i < reads.size(); i++) {
			SingleRead curRead = reads.get(i);

			// break if no more reads to read
			if (curRead == null) 
				break;

			int maxStartIndex = curRead.startPos + maxReadLength;

			for (int j = i + 1; j < reads.size(); j++) {
				SingleRead otherRead = reads.get(j);

				// break out of this curRead if there's nothing else that overlaps
				// ... or if no more reads to compare to
				if (otherRead == null || otherRead.startPos > maxStartIndex) 
					break;

				curRead.addNeighbor(otherRead);
			}
		}
	}

	static boolean isHeaderLine(String header) {
		return header.startsWith("@");
	}

	static int getHashIndex(String rname) {
		if (!names.containsKey(rname)) {
			names.put(rname, nextAvailIndex);
			nextAvailIndex++;
		}

		return ((Integer)names.get(rname)).intValue();
	}

	static void parseSAM() {
		int index = 0;
		int startPos = 0;
		int curRead = 0;
		int readLength;

		String line = "";
		String[] tokens;

		//BufferedReader reader = createReader("../data/SHFVkrc1_RC06 mapping.sam");
		try {
			//BufferedReader reader = new BufferedReader(new FileReader(new File("../data/SHFVkrc1_RC06 mapping.sam")));
			BufferedReader reader = new BufferedReader(new FileReader(new File(INPUT_SAM_FILE)));
			//int i = 0;
			while (line != null) {
				line = reader.readLine();
				if (line != null) {
					tokens = line.split("\t");
					if (tokens != null && tokens.length > 0 && !isHeaderLine(tokens[0])) {
						index = getHashIndex(tokens[RNAME]);
						startPos = Integer.parseInt(tokens[POS]);
						readLength = tokens[SEQ].length();

						if (readLength > 0) {
							reads.add(new SingleRead(tokens[SEQ], startPos));
						}
					}
				} 

				// TODO: uncomment to limit number of reads processed
				//if (++i > 10) break;
			}
			
			reader.close();
			
			// sort the collection by the start position
			Collections.sort(reads);
			
		} catch (IOException e) {
			e.printStackTrace();
		}
	}
}

class PosPair {
	public int i;
	public int j;
	
	public PosPair(int i, int j) {
		this.i = i;
		this.j = j;
	}

	public int first() {
		return i;
	}

	public int second() {
		return j;
	}
	
	public int hashCode() {
		return i * j;
	}
	
	public boolean equals(Object obj) {
		if (this == obj) return true;
		if (obj == null) return false;
		if (getClass() != obj.getClass()) return false;
		
		PosPair other = (PosPair)obj;
		return other.i == this.i && other.j == this.j;		
	}
}

class CooccuringBases {
	public int i;
	public int j;
	static char bases[] = {'A', 'T', 'C', 'G'}; 
	
	static Map<CooccuringBases, Integer> createFrom4x4array(int[][] counts) {
		assert(counts.length == 4 && counts[0].length == 4);
		
		Map<CooccuringBases, Integer> theseCounts = new HashMap<CooccuringBases, Integer>();
		for (int n = 0; n < bases.length; n++) {
			for (int m = 0; m < bases.length; m++) {
				int thisCount = counts[n][m];
				if (thisCount != 0) {
					theseCounts.put(new CooccuringBases(n, m), thisCount);
				}
			}
		}
		
		return theseCounts;
	}
	
	public CooccuringBases(int i, int j) {
		this.i = i;
		this.j = j;
	}
	
	public char firstBase() {
		return bases[this.i];
	}
	
	public char secondBase() {
		return bases[this.j];
	}
	
	public int baseByte() {
		return i << 2 | j;
	}
	
	public int hashCode() {
		return i * bases.length + j;
	}
	
	public boolean equals(Object obj) {
		if (this == obj) return true;
		if (obj == null) return false;
		if (getClass() != obj.getClass()) return false;
		
		CooccuringBases other = (CooccuringBases)obj;
		return other.i == this.i && other.j == this.j;
	}
}

class SingleRead implements Comparable<SingleRead> {
	// PApplet p; // hold the processing parent applet to make processing-specific calls

	char[] reads;
	int startPos;
	int length;

	boolean[] variantsToThis;
	int[][] neighborCounts;

	//SingleRead(String reads, int startPos, PApplet p) {
	SingleRead(String reads, int startPos) {
		this.reads = reads.toCharArray();
		this.length = reads.length(); 
		//this.p = p;
		
		if (startPos <= 0) { 
			System.err.println("got 0 for 1-based start index: " + startPos);
			startPos = 1;
		}
		
		// convert 1-based SAM POS to 0-based
		this.startPos = startPos - 1;

		variantsToThis = new boolean[this.length];
		neighborCounts = new int[this.length][4];
		// System.out.println("sequence: " + this.startPos + " to " + (this.startPos + this.length));
	}
	
	// helps sort reads by their starting position
	public int compareTo(SingleRead o) {
		return this.startPos - o.startPos;
	}

	// returns: the position of the last read of this object
	int lastPos() {
		return this.startPos + this.length - 1;
	}

	// returns: if the other read overlaps any reads with this one
	boolean overlaps(SingleRead other) {
		return 
				((other.startPos <= this.lastPos()) && (other.startPos >= this.startPos)) ||
				((other.lastPos() >= this.startPos) && (other.lastPos() <= this.lastPos()));
	}
	
	// returns: if the given absolute position is covered by this read
	boolean overlaps(int absPos) {
		return (this.startPos <= absPos && this.lastPos() >= absPos);
	}

	// stub method: addNeighbor()
	// functionality: adds the neighbors reads *that overlap*, 
	//   so each read is aware of all other overlapping reads
	void addNeighbor(SingleRead other) {

		// don't do anything if these reads don't overlap
		if (overlaps(other)) {
			if (other.startPos >= this.startPos) {
				int thisLastPos = other.lastPos() > this.lastPos() ? this.lastPos() : other.lastPos();
				int thisCurPos = other.startPos - this.startPos;
				for (int otherCurPos = 0; otherCurPos < (thisLastPos - other.startPos); otherCurPos++) {
					// get the integer representation of the reads
					int otherRead = bpToIndex(other.reads[otherCurPos]);
					int thisRead = bpToIndex(this.reads[thisCurPos]);

					// increment the counts of variants
					this.neighborCounts[thisCurPos][otherRead]++;
					other.neighborCounts[otherCurPos][thisRead]++;

					if (otherRead != thisRead) {
						this.variantsToThis[thisCurPos] = true;
						other.variantsToThis[otherCurPos] = true;
					}

					// increment this position (otherCurPos is done in the for-loop)
					thisCurPos++;
				}
			} else { // other.startPos < this.startPos
				int lastPos = other.lastPos() < this.lastPos() ? other.lastPos() : this.lastPos();
				int otherCurPos = this.startPos - other.startPos;

				for (int thisCurPos = 0; thisCurPos < (lastPos - this.startPos); thisCurPos++) {
					int thisRead = bpToIndex(this.reads[thisCurPos]);
					int otherRead = bpToIndex(other.reads[otherCurPos]);

					// increment the counts of variants
					this.neighborCounts[thisCurPos][otherRead]++;
					other.neighborCounts[otherCurPos][thisRead]++;

					if (otherRead != thisRead) {
						this.variantsToThis[thisCurPos] = true;
						other.variantsToThis[otherCurPos] = true;
					}

					// increment other position (thisCurPos is done in the for-loop)
					otherCurPos++;
				}
			}
		}
	}
	
	char getReadAtAbsolutePos(int absPos) {
		// convert to local coordinate frame
		int curPos = absPos - this.startPos;
		
		// do some edge checking
		if (curPos < 0 || curPos >= this.length) {
			System.err.println("Error trying to access abs position (" + absPos + ") in read " + this.startPos + "--" + (this.startPos+this.length));
			// throw new Exception("illegal read at position " + absPos);
			return ' ';
		}
		
		// otherwise, return the read character
		return this.reads[curPos];
	}

	void printNeighborCounts() {
		for (int i = 0; i < this.length; i++) {
			System.out.println("A = " + neighborCounts[i][0] + ", T = " + neighborCounts[i][1] + ", C = " + neighborCounts[i][2] + ", G = " + neighborCounts[i][3]);
		} 
	}

	static int bpToIndex(char bp) {
		int index = -1;

		switch (bp) {
		case 'A':
		case 'a':
			index = 0;
			break;

		case 'T':
		case 't':
			index = 1;
			break;

		case 'C':
		case 'c':
			index = 2;
			break; 

		case 'G':
		case 'g':
			index = 3;
			break;
		}

		return index;
	}
}

