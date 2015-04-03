import java.io.BufferedReader;
import java.io.DataOutputStream;
import java.io.FileNotFoundException;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.PrintWriter;
import java.text.DecimalFormat;
import java.util.*;

import processing.core.*;

import org.apache.commons.math3.stat.inference.*;

public class CoOccurReboot extends PApplet {

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
	
	char bases[] = {'A', 'T', 'C', 'G'};

	HashMap<String, Integer> names = new HashMap<String, Integer>(); 
	int nextAvailIndex = 0;

	int numPos = 16000; // maximum number of positions to keep track of
	int numReads = 122890; // maximum number of reads to keep track of
	int windowSize = 300; // window size around (+/-) position of interest to track co-occurences
	
	enum CooccurMetric { CONJ_PROB, DIFF_FROM_EXPECTED, RATIO_OF_EXPECTED_TO_OBSERVED, MUTUAL_INFORMATION };
	
	int[] givenConsensus; // hold a particular consensus to determine variants
	int[] modalConsensus; // holds the modal consensus.
	double[] variantProbabilities; // holds the variant probabilities at each position i
	double[][] readConjProbabilities; // holds the cooccurence variants at j given variants at i
	
	short[][][] variantCounts; // holds the modal and variant counts at position i and j (reads that encompass both)
	short[][] basesCounts; // holds the counts of each base possibility at each position i
	
	double[] cooccurenceMetric; // holds the 1D metric of cooccurence
	double maxCooccurMetric; // holds the maximum value of above
	double minCooccurMetric; // holds the minimum value of above
	
	float[][] readDistribution; // the distribution of reads at each position
	int[] readDepth; // the read depth at every position
	double[][] readCounts; // the counts of each base for every position (readCounts[i][n] / readDepth[i] = distribution) 
	int[][] readBreadth; // the count of how many reads span from pos i to pos j
	int maxValue;
	int maxPosition;

	SingleRead[][] reads;
	
	int actualReads = 0;

	public static void main(String[] args) {
		PApplet.main(new String[] { "--present", "CoOccurReboot" });
	}

	public void setup() {
		// defaults to filling with zeros; see 
		// http://docs.oracle.com/javase/specs/jls/se7/html/jls-4.html#jls-4.12.5
		reads = new SingleRead[1][numReads];

		DecimalFormat df = new DecimalFormat("0.00");
		long startTime, endTime;
		System.out.print("parsing SAM file took ... ");
		startTime = System.nanoTime();
		parseSAM();
		endTime = System.nanoTime();
		System.out.println(df.format((endTime - startTime) / 1e9) + " seconds");
		
		// unused right now..
		// populateAllReads();

		// do a test run; just calculate read depth at every position
		dumpConjProbabilities(CooccurMetric.DIFF_FROM_EXPECTED);
		//drawConjProbabilities();
		
		//getReadDepth();
		//doReadBreadth();
		// doReadDiversity();
	}

	// draw is called over and over
	public void draw() {
		//drawReadDepth();
		//drawReadBreadth();
		//drawCooccurenceMetric();
	}
	
	void doReadDiversity() {
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
	
	void doReadBreadth() {
		doReadBreadth(true);
	}
	
	void doReadBreadth(boolean writeBinary) {
		getReadBreadth();
		
		
		// dump to file
		if (writeBinary) {
			try {
				String outputFile = "../data/readBreadth.dat";
				System.out.print("writing to " + outputFile + " ...");
				
				DataOutputStream os = new DataOutputStream(new FileOutputStream(outputFile));
				os.writeInt(2 * windowSize + 1); // number of items around a position (numWindow)
				os.writeInt(numPos);             // number of positions captured
				os.writeInt(1);                  // number of datums per element
				
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
			PrintWriter file = createWriter(dataPath("../../data/readBreadth.csv"));
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
		}
	}
	
	void getReadDiversity() {
		// hold the minimum read that starts at the current position i
		int minReadPos = 0;
		cooccurenceMetric = new double[numPos];
		
		minCooccurMetric = Double.MAX_VALUE;
		maxCooccurMetric = Double.MIN_VALUE;
		
		// for each position i, separate into four categories
		for (int i = 0; i < numPos; i++) {
			int numReadsAtThisPos = 0;
			Map<Character, ArrayList<SingleRead>> categories = new HashMap<Character, ArrayList<SingleRead>>();
			
			for (int n = minReadPos; n < numReads; n++) {
				SingleRead curRead = reads[0][n];
				
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
	
	void drawCooccurenceMetric() {
		size(600,600);
		noStroke();
		
		for (int i = 0; i < 500; i++) {
			fill((float)(255.f * (((float)cooccurenceMetric[i] - minCooccurMetric) / (maxCooccurMetric - minCooccurMetric))), 0.f, 0.f);
			rect(((i) % 23) * 26 + 1, ((i) / 23) * 26 + 1, 25, 25, 7);
		}
		
		save(dataPath("../../data/cooccurence.png"));
	}
	
	private double getChiSquaredDiff(double[] pop, long[] sample) {
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
	
	private float getChiSquaredDistOld(float[][] pop, float[][] sample) {
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
	
	void getReadBreadth() {
		readBreadth = new int[numPos][numPos];
		actualReads = 0;
		
		for (int i = 0; i < numReads; i++) {
			SingleRead curRead = reads[0][i];
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
	
	void drawReadBreadth() {
		size(maxPosition, maxPosition);
		noStroke();
		
		for (int i = 0; i < maxPosition; i++) {
			for (int j = 0; j < maxPosition; j++) {
				fill((float)(255.f * ((float)readBreadth[i][j] / maxValue)), 0.f, 0.f);
				rect(i, j, 1, 1);
			}
		}
		
		save(dataPath("../../data/testDepth.png"));
	}
	
	void getConjProbabilityFromModalConcensus(CooccurMetric metric) {
		modalConsensus = new int[numPos];
		variantProbabilities = new double[numPos];
		readConjProbabilities = new double[numPos][numPos];
		
		// initialize counts as well
		basesCounts = new short[numPos][];
		variantCounts = new short[numPos][numPos][4];
		
		Map<Integer, Map<Character, ArrayList<SingleRead>>> readCategories = new HashMap<Integer, Map<Character, ArrayList<SingleRead>>>();
		int minReadPos = 0;
		
		// get the consensus sequence and collect reads at the same time
		for (int i = 0; i < numPos; i++) {
			int numReadsAtThisPos = 0;
			
			short[] readCounts = new short[4];
			Map<Character, ArrayList<SingleRead>> curCategories = new HashMap<Character, ArrayList<SingleRead>>();
			// collect reads for this position
			for (int n = minReadPos; n < numReads; n++) {
				SingleRead curRead = reads[0][n];
				
				if (curRead == null) break;
				if (curRead.startPos > i) break;
				
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
					totalCounts += readCounts[b];
					if (readCounts[b] > maxCounts) {
						maxRead = b;
						maxCounts = readCounts[b];
					}
				}
				
				// populate the baseCount for this position
				basesCounts[i] = readCounts;
				
				modalConsensus[i] = maxRead;
				
				// calculate the variant probability at this position i
				variantProbabilities[i] = ((double)(totalCounts - maxCounts)) / totalCounts;
			}
		}
		
		// now actually do some calculations
		for (int i = 0; i < numPos; i++) {
			// what's the modal read here?
			int modalRead = modalConsensus[i];
			
			// skip if no reads at this location
			if (modalRead == -1) continue;
			
			Map<Character, ArrayList<SingleRead>> thisCategories = readCategories.get(i);
			
			// now go through every other read j that spans around this i
			for (int j = Math.max(0, i - windowSize); j < (i + windowSize); j++) {
				
				// iterate through each i-category (as long as it's not the modal one)
				// double variantsi = 0, variantsij = 0, modals = 0;
				double vari_varj = 0, vari_modalj = 0, modali_varj = 0, modali_modalj = 0; 
				for (Map.Entry<Character, ArrayList<SingleRead>> category : thisCategories.entrySet()) {
					// check for modality of i; if so, count all reads that span j
					if (bases[modalRead] == category.getKey()) {
						for (SingleRead curRead : category.getValue()) {
							if (!curRead.overlaps(j)) continue;
							
							if (curRead.getReadAtAbsolutePos(j) == bases[modalConsensus[j]])
								modali_modalj++;
							else
								modali_varj++;
						}
					} else {
						for (SingleRead curRead : category.getValue()) {
							// skip those that don't span j
							if (!curRead.overlaps(j)) continue;
							
							// add to counter based on modality of the jth read
							if (curRead.getReadAtAbsolutePos(j) == bases[modalConsensus[j]])
								vari_modalj++;
							else
								vari_varj++;
						}
					}
				}
				
				// populate the variant counts for reads that encompass i and j
				variantCounts[i][j][0] = (short)(modali_varj + modali_modalj);
				variantCounts[i][j][1] = (short)(vari_varj + vari_modalj);
				variantCounts[i][j][2] = (short)(vari_modalj + modali_modalj);
				variantCounts[i][j][3] = (short)(vari_varj + modali_varj);
				
				double totalCounts = vari_varj + vari_modalj + modali_varj + modali_modalj;
				
				switch (metric) {
					case DIFF_FROM_EXPECTED: 
						double vari = vari_modalj + vari_varj;
						double modali = modali_modalj + modali_varj;
						
						double prob_varj_cond_vari = vari == 0.0 ? 0.0 : vari_varj / vari;
						double prob_varj_cond_modali = modali == 0.0 ? 0.0 : modali_varj / modali;
						
						readConjProbabilities[i][j] = prob_varj_cond_vari - prob_varj_cond_modali;
						break;
					
					case CONJ_PROB:
						double probVariantsI = (vari_modalj + vari_varj) / 1.0 / Math.max(1, totalCounts);
						double probVariantsIJ = vari_varj / 1.0 / Math.max(1, totalCounts);
						
						if (probVariantsI == 0.0) 
							readConjProbabilities[i][j] = 0.0;
						else
							readConjProbabilities[i][j] = probVariantsIJ / probVariantsI;
						
					// TODO: implement Mike's metric
					case RATIO_OF_EXPECTED_TO_OBSERVED:
						readConjProbabilities[i][j] = 0.0;
						break;
				
					case MUTUAL_INFORMATION:
						readConjProbabilities[i][j] = 0.0;
						break;
				}
			}
		}
	}
	
	void dumpConjProbabilities(CooccurMetric metric) {
		dumpConjProbabilities(metric, true);
	}
	
	void dumpConjProbabilities(CooccurMetric metric, boolean writeBinary) {
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
				String outputFile = "../data/conjProbDiff.dat";
				System.out.print("writing to " + outputFile + " ...");
				DataOutputStream os = new DataOutputStream(new FileOutputStream(outputFile));
				// write dimensions (two three ints)
				os.writeInt(2 * windowSize + 1); // window size (numWindow)
				os.writeInt(numPos);             // number of positions (numPos)
				os.writeInt(1);                  // number of datums per element
				
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
			} catch (FileNotFoundException e) {
				e.printStackTrace();
			} catch (IOException e) {
				e.printStackTrace();
			}
			
			// dump counts as well!
			if (true) {
				try {
					String outputFile = "../data/baseCounts.dat";
					System.out.print("writing base counts to " + outputFile + " ...");
					DataOutputStream os = new DataOutputStream(new FileOutputStream(outputFile));
					
					// write dimensions (three ints)
					os.writeInt(1);
					os.writeInt(numPos);
					os.writeInt(4);
					
					for (int i = 0; i < numPos; i++) {
						// does this position have data?
						if (basesCounts[i][0] + basesCounts[i][1] + basesCounts[i][2] + basesCounts[i][3] == 0)
							continue;
						
						// write the index (sparse representation)
						os.writeShort(i);
						
						for (int n = 0; n < 4; n++) {	
							os.writeShort(basesCounts[i][n]);
						}
					}
					
					os.flush();
					os.close();
					
					System.out.println(" finished.");
					
					outputFile = "../data/varCounts.dat";
					System.out.print("writing variant counts to " + outputFile + " ...");
					os = new DataOutputStream(new FileOutputStream(outputFile));
					
					// write dimensions (three ints)
					os.writeInt(2 * windowSize + 1);
					os.writeInt(numPos);
					os.writeInt(4);
					
					for (int i = 0; i < numPos; i++) {
						for (int dj = -windowSize; dj <= windowSize; dj++) {
							int j = i + dj;
							if (j < 0 || j >= numPos)
								continue;
							
							short[] curPos = variantCounts[i][j];
							// does this position i,j have data?
							if (curPos[0] + curPos[1] + curPos[2] + curPos[3] == 0)
								continue;
							
							// write the curent index and the four data values
							os.writeShort(i * (2 * windowSize + 1) + (dj + windowSize));
							for (int n = 0; n < 4; n++) {
								os.writeShort(curPos[n]);
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
			}
		} else {
			String outputFile = "../../data/conjProbDiff.csv";
			System.out.print("writing to " + outputFile + " ...");
			PrintWriter file = createWriter(dataPath(outputFile));
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
		}
		
		endTime = System.nanoTime();
		System.out.println(df.format((endTime - startTime) / 1e9) + " seconds");
		
		//drawCooccurrenceMetric();
	}
	
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

	void getReadCounts() {
		actualReads = 0;
		readDepth = new int[numPos];
		readCounts = new double[numPos][4];
		
		// add up counts
		for (int i = 0; i < numReads; i++) {
			SingleRead thisRead = reads[0][i];
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
	
	void getReadDistribution() {
		int[] depth = new int[numPos];
		readDistribution = new float[numPos][4];
		
		// based on the current read position, this variable holds the index of the first read that could overlap
		for (int i = 0; i < numReads; i++) {
			SingleRead curRead = reads[0][i];
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

	void populateAllReads() {
		int maxReadLength = 300;
		for (int i = 0; i < numReads; i++) {
			SingleRead curRead = reads[0][i];

			// break if no more reads to read
			if (curRead == null) 
				break;

			int maxStartIndex = curRead.startPos + maxReadLength;

			for (int j = i + 1; j < numReads; j++) {
				SingleRead otherRead = reads[0][j];

				// break out of this curRead if there's nothing else that overlaps
				// ... or if no more reads to compare to
				if (otherRead == null || otherRead.startPos > maxStartIndex) 
					break;

				curRead.addNeighbor(otherRead);
			}
		}
	}

	boolean isHeaderLine(String header) {
		return header.startsWith("@");
	}

	int getHashIndex(String rname) {
		if (!names.containsKey(rname)) {
			names.put(rname, nextAvailIndex);
			nextAvailIndex++;
		}

		return ((Integer)names.get(rname)).intValue();
	}

	void parseSAM() {
		int index = 0;
		int startPos = 0;
		int curRead = 0;
		int readLength;

		String line = "";
		String[] tokens;

		BufferedReader reader = createReader("../data/SHFVkrc1_RC06 mapping.sam");
		int i = 0;
		while (line != null) {
			try {
				line = reader.readLine();
				if (line != null) {
					tokens = splitTokens(line, "\t");
					if (tokens != null && tokens.length > 0 && !isHeaderLine(tokens[0])) {
						index = getHashIndex(tokens[RNAME]);
						startPos = Integer.parseInt(tokens[POS]);
						readLength = tokens[SEQ].length();

						if (readLength > 0) {
							reads[index][curRead++] = new SingleRead(tokens[SEQ], startPos, this);
						}
					}
				}
			} 
			catch (IOException e) {
				e.printStackTrace();
			}

			// TODO: uncomment to limit number of reads processed
			//if (++i > 1000) break;
		}
	}
}

class SingleRead {
	PApplet p; // hold the processing parent applet to make processing-specific calls

	char[] reads;
	int startPos;
	int length;

	boolean[] variantsToThis;
	int[][] neighborCounts;

	SingleRead(String reads, int startPos, PApplet p) {
		this.reads = reads.toCharArray();
		this.length = reads.length(); 
		this.p = p;
		
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
		return (this.startPos <= absPos && this.lastPos() > absPos);
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


