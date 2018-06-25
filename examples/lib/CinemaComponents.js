'use strict';
(function() {
	/**
	 * CINEMA_COMPONENTS
	 * DATABASE
	 * 
	 * The Database module for the CINEMA_COMPONENTS library.
	 * Contains functions and objects for dealing with the purely data-related 
	 * parts of a SpecD database. (Parsing, Querying, etc. data. No GUI stuff)
	 * 
	 * @exports CINEMA_COMPONENTS
	 * 
	 * @author Cameron Tauxe
	 */

	//If CINEMA_COMPONENTS is already defined, add to it, otherwise create it
	var CINEMA_COMPONENTS = {}
	if (window.CINEMA_COMPONENTS)
		CINEMA_COMPONENTS = window.CINEMA_COMPONENTS;
	else
		window.CINEMA_COMPONENTS = CINEMA_COMPONENTS;

	/** @type {boolean} - Flag to indicate that the Database module has been included */
	CINEMA_COMPONENTS.DATABASE_INCLUDED = true;

	/**
	 * Enum for the type of dimension (column)
	 * @enum {number}
	 */
	CINEMA_COMPONENTS.DIMENSION_TYPE = Object.freeze({
			INTEGER: 0,
			FLOAT: 1,
			STRING: 2
		});
	
	/**
	 * Database
	 * Creates a new instance of Database which represents the data in a SpecD Database
	 * 
	 * @constructor
	 * @param {string} directory - Path to the '.cdb' directory containing the database
	 * @param {function({Database} self)} callback - Function to call when loading has finished 
	 * (only called if loading finished without errors)
	 * @param {function({string} message)} errorCallback - Function to call if errors were found with data
	 */
	CINEMA_COMPONENTS.Database = function(directory, callback, errorCallback) {
		/** @type {string} - Path to the '.cdb' directory containing the database */
		this.directory = directory;
	
		/** @type {boolean} - Whether or not the database has finished loading */
		this.loaded = false;

		/** @type {string?} - The error message for errors found in the data. Undefined if no errors */
		this.error;

		/** @type {Object[]} - An array of the data rows */
		this.data = [];
		/** @type {string[]} - An array of dimension names for the data (column headers) */
		this.dimensions = [];
		/** @type {Object} - Contains the type for each dimension */
		this.dimensionTypes = {};
		/** @type {Object} - Contains the domains for each dimension (formatted like the domain for a d3 scale) */
		this.dimensionDomains = {};

		/** @type {boolean} Whether or not this database has additional axis ordering data */
		this.hasAxisOrdering = false;
		/** @type {Object} Axis Ordering data (if it exists) */
		this.axisOrderData;

		var self = this;
		getAndParseCSV(directory+'/data.csv', function(data_arr) {
			//Check for errors
			self.error = checkErrors(data_arr);
			if (self.error) {
				if (errorCallback)
					errorCallback();
				return;
			}

			//Get dimensions (First row of data)
			self.dimensions = data_arr[0];
			
			//Convert rows from arrays to objects
			self.data = data_arr.slice(1).map(function(d) {
				var obj = {};
				self.dimensions.forEach(function(p,i){obj[p] = d[i];});
				return obj;
			});

			//Determine dimension types and calculate domains
			self.dimensions.forEach(function(d) {
				var val = self.data[0][d];

				for (i = 0; i < self.data.length; i++) {
					if (self.data[i][d]) {
						val = self.data[i][d];
						break;
					}
				}

				//Check if value is a float or integer
				//The text "NaN" (not case sensitive) counts as a float
				if (val && (!isNaN(val) || val.toUpperCase() === "NAN")) {
					if (isNaN(val) || !Number.isInteger(val))
						self.dimensionTypes[d] = CINEMA_COMPONENTS.DIMENSION_TYPE.FLOAT;
					else
						self.dimensionTypes[d] = CINEMA_COMPONENTS.DIMENSION_TYPE.INTEGER;
					//calculate domain for numeric dimension
					var i;//the first index to contain a value that is not "NaN"
					for (i = 0; i < self.data.length && isNaN(self.data[i][d]); i++) {}
					if (i == self.data.length)
						//if all values are NaN, domain is [0,0]
						self.dimensionDomains[d] = [0,0]
					else {
						var min = self.data[i][d];
						var max = self.data[i][d];
						for (var j = i; j < self.data.length; j++) {
							if (!isNaN(self.data[j][d])) {
								min = Math.min(min,self.data[j][d]);
								max = Math.max(max,self.data[j][d]);
							}
						}
						self.dimensionDomains[d] = [min,max];
					}
				}
				//Anything else is a string type
				else {
					self.dimensionTypes[d] = CINEMA_COMPONENTS.DIMENSION_TYPE.STRING;
					self.dimensionDomains[d] = self.data.map(function(p){return p[d];});
				}
			});//end dimensions.foreach()

			//Attempt to load an axis_order.csv file
			getAndParseCSV(directory+'/axis_order.csv',
				//Normal callback, if axis_order.csv found
				function(axis_data_arr) {
					var error = checkAxisDataErrors(axis_data_arr,self.dimensions);
					if (!error) {
						self.hasAxisOrdering = true;
						self.axisOrderData = parseAxisOrderData(axis_data_arr);
					}
					else
						console.warn("ERROR in axis_order.csv: " + error);
					self.loaded = true;
					if (callback)
						callback(self);
				},
				//Error callback, if axis_order.csv request fails
				function() {
					self.loaded = true;
					if (callback)
						callback(self);
				}
			);
		//errorCallback. If data.csv request fails
		}, function() {
			if (errorCallback)
				errorCallback("Error loading data.csv!");
		}); //end getAndParseCSV()
	}; //end constructor

	/**
	 * Shortcut function to check if a given dimension is of type string or not
	 * @param {string} dimension - The dimension to check
	 */
	CINEMA_COMPONENTS.Database.prototype.isStringDimension = function(dimension) {
		return this.dimensionTypes[dimension] === CINEMA_COMPONENTS.DIMENSION_TYPE.STRING;
	};

	/**
	 * Get data rows (returned as an array of indices) that are similar to the given data.
	 * Difference between two data points is measured as the Manhattan distance where each dimension
	 * is normalized. i.e. The sum of the differencs on each dimension (each scaled from 0 to 1).
	 * On string dimensions, the distance is considered 0 if the strings are the same, otherwise 1
	 * NaN values have 0 distance from each other, but 1 from anything else
	 * undefined values 0 distance from each other, but 1 from defined values
	 * @param {Object} query - An object representing the data to compare against 
	 * (it does not necessarily have to be a data point already in the database)
	 * (dimensions in query can be undefined and will not add to distance)
	 * @param {number} threshold - The value that the difference must be below to be considerd "similiar"
	 */
	CINEMA_COMPONENTS.Database.prototype.getSimilar = function(query, threshold) {
		var self = this;
		var similar = [];
		this.data.forEach(function(row,index) {
			var dist = 0; //manhattan distance
			self.dimensions.forEach(function(d) {
				if (query[d] !== undefined) {
					//On string dimensions, the distance is considered 0 if the strings are the same, otherwise 1
					if (self.isStringDimension(d))
						dist += (row[d] == query[d] ? 0 : 1);
					//Compare number dimensions
					else {
						//NaN values have 0 distance from each other, but 1 from anything else
						if (isNaN(query[d]))
							dist += (isNaN(row[d]) ? 0 : 1);
						//undefined values 0 distance from each other, but 1 from defined values
						else if (row[d] === undefined)
							dist += 1;
						//calculate normalized distance
						else {
							var extent = self.dimensionDomains[d];
							dist += Math.abs(
								getNormalizedValue(query[d],extent[0],extent[1])
								-
								getNormalizedValue(row[d],extent[0],extent[1])
							);
						}
					}
				}
			});//end self.dimensions.forEach()
			if (dist <= threshold) {
				similar.push(index);
			}
		});//end this.data.forEach()
		return similar;
	}
	
	/**
	 * Parse this database's axis data from the given array of data (from axis_order.csv)
	 */
	var parseAxisOrderData = function(data_arr) {
		var data = {};

		data_arr.slice(1).forEach(function(row) {
			var category = row[0];
			if (!data[category])
				data[category] = [];
			var value = row[1];
			data[category].push({name: value});
			var ordering = data_arr[0].slice(2).map(function(d,i) {
				return [row[i+2],i];
			}).sort(function(a,b) {
				if (a[0] === undefined) {return 1;}
				if (b[0] === undefined) {return -1;}
				return a[0]-b[0];
			}).map(function(d) {return data_arr[0].slice(2)[d[1]];});
			data[category][data[category].length-1].order = ordering;
		});

		return data;
	}

	//Fetch a csv file, parse data out of it. Return data with callback
	var getAndParseCSV = function(path,callback,errorCallback) {
		var request = new XMLHttpRequest();
		request.open("GET",path,true);
		request.onreadystatechange = function() {
			if (request.readyState === 4) {
				if (request.status === 200 || 
						//Safari returns 0 on success (while other browsers use 0 for an error)
						(navigator.userAgent.match(/Safari/) && request.status === 0)
				) {
					var data = parseCSV(request.responseText);
					if (callback)
						callback(data);
				}
				else if (errorCallback) {
					errorCallback();
				}
			}
		}
		request.send(null);
	}
	
	//Get a value from 0 to 1 reprsenting where val lies between min and max
	var getNormalizedValue = function(val, min, max) {
		return (max-min == 0) ? 0 : ((val-min) / (max-min));
	}

	/*
	* Parse the text of a csv file into a 2 dimensional array.
	* Distinguishes between empty strings and undefined values
	*
	* Based on example code from Ben Nadel
	* https://www.bennadel.com/blog/1504-ask-ben-parsing-csv-strings-with-javascript-exec-regular-expression-command.htm
	*/
	var parseCSV = function(csvText) {
		//               (delimiter)     (quoted value)           (value)
		var csvRegex = /(\,|\r?\n|\r|^)(?:"([^"]*(?:""[^"]*)*)"|([^\,\r\n]*))/gi;
		var data = [];
		var matches;
		//If text is empty, stop now. Otherwise will get caught in infinite loop
		if (csvText === "")
			return data;
		while (matches = csvRegex.exec(csvText)) {
			//Newline,beginning of string, or a comma
			var delimiter = matches[1];
			//If the value is in quotes, it will be here (without the outside quotes)
			var quotedValue = matches[2];
			//If the value wasn't in quotes, it will be here
			var value = matches[3];
	
			//If the deilimiter is not a comma (meaning its a new line),
			//add a row to the data
			if (delimiter != ',')
				data.push([]);
			//If a quoted value, escape any pairs of quotes and add to data
			if (quotedValue !== undefined)
				data[data.length-1].push(quotedValue.replace(/""/g,"\""));
			//If an unquoted value, escape any pairs of quotes add to data, or undefined if empty
			else
				data[data.length-1].push(value === "" ? undefined : value.replace(/""/g,"\""));
		}
		//If the last line is a single, undefined value (caused by a stray newline at the end of the file), remove it.
		if (data.length > 1 && data[data.length-1].length == 1 && data[data.length-1][0] === undefined) {
			data = data.slice(0,data.length-1);
		}
		return data;
	}

	/*
	 * Check for critical errors in the given data.
	 * Returns an error message if an error was found.
	 * Doesn't return anything if no errors were found.
	 */
	var checkErrors = function(data) {
		//Check that there are at least two lines of data
		if (data.length < 2)
			return "The first and second lines in the file are required.";

		//Check that there at least two dimensions to the data
		if (data[0].length < 2)
			return "The dataset must include at least two dimensions";

		//Check that there are no empty values in the first two rows
		var emptyValFound = false;
		for (var i in data[0])
			emptyValFound = emptyValFound || (data[0][i] === undefined);
		if (emptyValFound)
			return "Empty values may not occur in the header (first line).";

		//Check that all rows of data have the same length
		var testLength = data[0].length;
		for (var i in data)
			if (data[i].length != testLength)
				return "Each line must have an equal number of comma separated values (columns).";
	}

	/**
	 * Check for critical errors in the given axis data
	 * Checks against the given list of dimensions
	 * Returns an error message if an error was found.
	 * Doesn't return anything if no errors were found
	 */
	var checkAxisDataErrors = function(data, dimensions) {
		//Check that there are at least two lines of data
		if (data.length < 2)
			return "The first and second lines in the file are required.";

		//Check that all rows of data have the same length
		var testLength = data[0].length;
		for (var i in data)
			if (data[i].length != testLength)
				return "Each line must have an equal number of comma separated values (columns).";

		/*//Check that there are dimensions+2 columns (+2 for category and value columns)
		if (data[0].length !== dimensions.length+2)
			return "All dimensions must be specified in the header of the file."*/

		//Check that each dimension in the header is valid
		for (var i = 2; i < data[0].length; i++) {
			if (!dimensions.includes(data[0][i]))
				return "Dimension in axis order file '"+data[0][i]+"' is not valid";
		}

		//Check that the first two columns contain to undefined values
		for (var i = 0; i < data.length; i++) {
			if (data[i][0] === undefined)
				return "Category cannot be undefined."
			if (data[i][1] === undefined)
				return "Value cannot be undefined."
		}

		//Check that all other data are numbers
		for (var i = 1; i < data.length; i++) {
			for (var j = 2; j < data[i].length; j++) {
				if (isNaN(data[i][j]) && data[i][j] !== undefined)
					return "Values for dimensions cannot be NaN."
			}
		}
	}

})();
'use strict';
(function() {
	/**
	 * CINEMA_COMPONENTS
	 * COMPONENT
	 * 
	 * The Component module for the CINEMA_COMPONENTS library.
	 * Contiains the constructor for components (PcoordSVG,PcoordCanvas,Glyph, etc.)
	 * The object contains common methods and fields used by all components.
	 * 
	 * Also contains definitions for a few classes that may be used by components.
	 * 
	 * @exports CINEMA_COMPONENTS
	 * 
	 * @author Cameron Tauxe
	 */

	//If CINEMA_COMPONENTS is already defined, add to it, otherwise create it
	var CINEMA_COMPONENTS = {}
	if (window.CINEMA_COMPONENTS)
		CINEMA_COMPONENTS = window.CINEMA_COMPONENTS;
	else
		window.CINEMA_COMPONENTS = CINEMA_COMPONENTS;

	//Require that the database module be included
	if (!CINEMA_COMPONENTS.DATABASE_INCLUDED)
		throw new Error("CINEMA_COMPONENTS Component module requires that Database"+
				" module be included. Please make sure that Database module"+
				" is included BEFORE Component module");

	/** @type {boolean} - Flag to indicate that the Component module has been included */
	CINEMA_COMPONENTS.COMPONENT_INCLUDED = true;

	/**
	 * Abstract constructor for Component.
	 * Represents a component for displaying and interacting with a database.
	 * Objects such as Pcoord and Glyph inherit from this
	 * @param {DOM} parent - The DOM object to build this component inside of (all children will be removed)
	 * @param {CINEMA_COMPONENTS.Database} database - The database behind this component
	 * @param {RegExp} filterRegex - A regex to determine which dimensions to NOT show on the component
	 */
	CINEMA_COMPONENTS.Component = function(parent, database, filterRegex) {
		if (this.constructor === CINEMA_COMPONENTS.Component)
			throw new Error("Cannot instantiate abstract class 'Component.'"+
				" Please use a subclass.");

		/** @type {DOM} The parent DOM object to build this component inside of */
		this.parent = parent;

		//Clear children
		this.parent.innerHTML = '';

		/** @type {CINEMA_COMPONENTS.Database} A reference to the database behind this component */
		this.db = database;
		/** @type {string[]} The filtered list of dimensions that are shown on the component */
		this.dimensions = [];

		//NOTE that this.dimensions is filtered to have only the dimensions shown on the component
		//while this.db.dimensions includes all dimensions in the database

		/** @type {RegExp} The regex used to filter out dimensions to not be shown on the component*/
		this.filter = filterRegex;

		//Get filtered Dimensions according to filterRegex
		this.dimensions = this.db.dimensions.filter(function(d) {
			return filterRegex ? !filterRegex.test(d) : true;
		});

		//Create DOM content
		/** @type {DOM} The whole content of the component*/
		this.container = parent.appendChild(document.createElement('div'));
		this.container.setAttribute('class','CINEMA_COMPONENT');
		this.container.style.position = 'absolute';

		CINEMA_COMPONENTS.Component.prototype.updateSize.call(this);
	};

	/**
	 * Resize this component to fit the size of its parent.
	 * This should be called every time the size of the component's
	 * parent changes.
	 */
	CINEMA_COMPONENTS.Component.prototype.updateSize = function(){
		this.margin = this.margin || new CINEMA_COMPONENTS.Margin(0,0,0,0);
		this.parentRect = this.parent.getBoundingClientRect();
		this.internalWidth = this.parentRect.width - this.margin.left - this.margin.right;
		this.internalHeight = this.parentRect.height - this.margin.top - this.margin.bottom;

		this.container.style.width = this.parentRect.width+'px';
		this.container.style.height = this.parentRect.height+'px';
	};

	/**
	 * Remove this component from the scene
	 */
	CINEMA_COMPONENTS.Component.prototype.destroy = function() {
		d3.select(this.container).remove();
	};

	/**
	 * Constructor for Margin object
	 * Defines the top,right,bottom and left margins for drawing a component.
	 * @param {number} top - top margin (in pixels)
	 * @param {number} right - right margin (in pixels)
	 * @param {number} bottom - bottom margin (in pixels)
	 * @param {number} left - left margin (in pixels)
	 */
	CINEMA_COMPONENTS.Margin = function(top,right,bottom,left) {
		this.top = top;
		this.right = right;
		this.bottom = bottom;
		this.left = left;
	}

	/**
	 * Constructor for ExtraData object
	 * Defines extra, custom data that may be shown on a component.
	 * @param {Object} data - The data to show 
	 *     (in the same format as the data points in the database)
	 * @param {any} style - Object representing how to draw the data.
	 *     (the interpretation of this is up to specific components)
	 *     (for example PcoordSVG expects a CSS string and
	 *     PcoordCanvas expects an object with canvas context attributes)
	 */
	CINEMA_COMPONENTS.ExtraData = function(data, style) {
		this.data = data;
		this.style = style;
	}
})();'use strict';
(function() {
	/**
	 * CINEMA_COMPONENTS
	 * GLYPH
	 * 
	 * The Glyph Component for the CINEMA_COMPONENTS library.
	 * Contains the constructor for a Glyph component.
	 * The Glyph component allows for viewing one data point at a time in a glyph chart
	 * 
	 * @exports CINEMA_COMPONENTS
	 * 
	 * @author Cameron Tauxe
	 */

	//If CINEMA_COMPONENTS is already defined, add to it, otherwise create it
	var CINEMA_COMPONENTS = {}
	if (window.CINEMA_COMPONENTS)
		CINEMA_COMPONENTS = window.CINEMA_COMPONENTS;
	else
		window.CINEMA_COMPONENTS = CINEMA_COMPONENTS;

	//Require that the Component module be included
	if (!CINEMA_COMPONENTS.COMPONENT_INCLUDED)
		throw new Error("CINEMA_COMPONENTS Glyph module requires that Component"+
			" module be included. Please make sure that Component module"+
			" is included BEFORE Glyph module");

	//Require that d3 be included
	if (!window.d3) {
		throw new Error("CINEMA_COMPONENTS Glyph module requires that"+
		" d3 be included (at least d3v4). Please make sure that d3 is included BEFORE the"+
		" the Glyph module");
	}

	/** @type {boolean} - Flag to indicate that the Glpyph module has been included */
	CINEMA_COMPONENTS.GLYPH_INCLUDED = true;

	//Constants
	var RADTODEG = (180/Math.PI),
		DEGTORAD = (Math.PI/180);

	CINEMA_COMPONENTS.Glyph = function(parent, database, filterRegex) {
		var self = this;

		/***************************************
		 * SIZING
		 ***************************************/

		/** @type {CINEMA_COMPONENTS.Margin} Override default margin */
		this.margin = new CINEMA_COMPONENTS.Margin(50,50,50,50);
		/** @type {number} the space between the center and lowest data values on the chart */
		this.innerMargin;
		/** @type {number} The radius of the glyph */
		this.radius;

		//call super-constructor
		CINEMA_COMPONENTS.Component.call(this,parent,database,filterRegex);
		//after size is calculate in the super-constructor, set radius and innerMargin
		this.radius = Math.min(this.internalHeight,this.internalWidth)/2;
		this.innerMargin = this.radius/11;

		/***************************************
		 * DATA
		 ***************************************/

		 /** @type {number} The index of the selected data point */
		 this.selected = 0;

		/***************************************
		 * SCALES
		 ***************************************/

		/** @type {d3.scalePoint} Rotation scale. Maps dimensions to a rotation in radians */
		this.rotation = d3.scalePoint()
			.domain(this.dimensions)
			.range([0,Math.PI*2-Math.PI*2/(this.dimensions.length+1)]);
		
		/** @type {Object(d3.scale)} Scales for each dimension
		 * Maps a value to a distance from the center
		 */
		this.scales = {};
		this.dimensions.forEach(function(d) {
			//Create point scale for string dimensions
			if (self.db.isStringDimension(d))
				self.scales[d] = d3.scalePoint()
					.domain(self.db.dimensionDomains[d])
					.range([self.radius-self.innerMargin,0]);
			//Create linear scale for numeric dimensions
			else
				self.scales[d] = d3.scaleLinear()
					.domain(self.db.dimensionDomains[d])
					.range([self.radius-self.innerMargin,0]);
		});

		/***************************************
		 * DOM Content
		 ***************************************/

		//Create DOM content
		//Specify that this is a Glyph component
		d3.select(this.container).classed('GLYPH',true);

		/** @type {d3.selection (svg)} The SVG element containing all the content of the component */
		this.svg = d3.select(this.container).append('svg')
		.attr('class','glyphChart')
		.attr('viewBox',(-this.margin.right)+' '+(-this.margin.top)+' '+
						(this.parentRect.width)+' '+
						(this.parentRect.height))
		.attr('preserveAspectRatio','none')
		.attr('width','100%')
		.attr('height','100%');

		/** @type {d3.selection (path)} The path representing the selected data */
		this.path = this.svg.append('path')
			.classed('glyph',true);

		/** @type {d3.selection g} Labels for each dimension */
		this.labels = self.svg.append('g')
			.classed('labels',true)
		.selectAll('g.label')
			.data(this.dimensions)
			.enter().append('g')
				.classed('label',true)
				.attr('transform',function(d){return self.getAxisTransform(d);});
		//Add label text
		this.labels.append('text')
			.style('text-anchor','middle')
			.text(function(d){return d;})
			.attr('transform',function(d) {
				return "translate(0 -15) "
					+"rotate("+self.getTextRotation(d)+")";
			});


		/***************************************
		 * AXES
		 ***************************************/

		/** @type {d3.selection (g)} The SVG group containing all the axes */
		this.axisContainer = this.svg.append('g')
			.classed('axisContainer',true);

		/** @type {d3.selection (g)} Groups for each axis*/
		this.axes = this.axisContainer.selectAll('.axisGroup')
			.data(this.dimensions)
		.enter().append('g')
			.classed('axisGroup',true)
			.attr('transform',function(d){return self.getAxisTransform(d);});
		//Create d3 axes
		this.axes.append('g')
			.classed('axis',true)
			.each(function(d) {
				d3.select(this).call(d3.axisLeft().scale(self.scales[d]));
				d3.select(this).selectAll('text')
					.style('text-anchor','end')
					.attr('transform',"rotate("+self.getTextRotation(d)+" -15 0)");
			});

		this.redraw();
	}
	//establish prototype chain
	CINEMA_COMPONENTS.Glyph.prototype = Object.create(CINEMA_COMPONENTS.Component.prototype);
	CINEMA_COMPONENTS.Glyph.prototype.constructor = CINEMA_COMPONENTS.Glyph;

	/**
	 * Get the path (contents of the 'd' attribute) for the given data point
	 * @param {Object} p The data point
	 */
	CINEMA_COMPONENTS.Glyph.prototype.getPath = function(p) {
		var self = this;
		var path;
		var startPoint;
		this.dimensions.forEach(function(d,i) {
			var point = self.getPoint(d,p);
			if (i == 0) {
				startPoint = point;
				path = "M "+point.x+" "+point.y+" "
			}
			else if (i == self.dimensions.length-1) {
				//loop back to the start point at the end to close the path
				path += "L "+point.x+" "+point.y+" "+
						"L "+startPoint.x+" "+startPoint.y;
			}
			else {
				path += "L "+point.x+" "+point.y+" ";
			}
		});
		return path;
	}

	/**
	 * The x,y point on the chart where the given data point passes
	 * through the axis for the given dimension
	 * @param {string} d The dimension
	 * @param {Object} p The data point
	 */
	CINEMA_COMPONENTS.Glyph.prototype.getPoint = function(d,p) {
		if (isNaN(p[d]))
			//NaN values are placed in the center of the chart
			return {x: this.radius, y: this.radius};
		var len = this.radius-this.scales[d](p[d]);
		var rot = this.rotation(d)-Math.PI/2;
		var x = Math.cos(rot)*len;
		var y = Math.sin(rot)*len;
		return {x: x+this.radius, y: y+this.radius};
	}

	/**
	 * Should be called every time the size of the chart's container changes.
	 * Updates the sizing and scaling of all parts of the chart and redraws
	 */
	CINEMA_COMPONENTS.Glyph.prototype.updateSize = function() {
		var self = this;

		//Call super (will recalculate size)
		CINEMA_COMPONENTS.Component.prototype.updateSize.call(this);

		//Update radius and innerMargin
		this.radius = Math.min(this.internalHeight,this.internalWidth)/2;
		this.innerMargin = this.radius/11;

		//Rescale SVG
		this.svg.attr('viewBox',(-this.margin.right)+' '+(-this.margin.top)+' '+
				(this.parentRect.width)+' '+
				(this.parentRect.height))

		//Rescale scales
		this.dimensions.forEach(function (d) {
			self.scales[d].range([self.radius-self.innerMargin,0]);
		});

		//Re-transform axes
		this.axes.attr('transform',function(d){return self.getAxisTransform(d);})
		//Rebuild axes
		.each(function(d) {
			d3.select(this).call(d3.axisLeft().scale(self.scales[d]));
		});

		//Re-tranform labels
		this.labels.attr('transform',function(d){return self.getAxisTransform(d);});

		//Rebuild path
		this.path.attr('d',function(d) {return self.getPath(self.db.data[d]);});
	};

	/**
	 * Set the selected data point to the one with the given index
	 */
	CINEMA_COMPONENTS.Glyph.prototype.setSelected = function(index) {
		this.selected = index;
		this.redraw();

	};

	/**
	 * Redraw the glyph path
	 */
	CINEMA_COMPONENTS.Glyph.prototype.redraw = function() {
		var self = this;
		this.path.datum(this.selected)
			.transition(1000)
				.attr('d',function(d){return self.getPath(self.db.data[d]);});
	}

	/**
	 * Get the transform attribute for an axis with the given dimension
	 * @param {string} d The dimension to transform to
	 */
	CINEMA_COMPONENTS.Glyph.prototype.getAxisTransform = function(d) {
		var r = this.radius;
		var rot = this.rotation(d)*RADTODEG;
		return "translate("+r+") "+
			"rotate("+rot+" 0 "+r+")";
	};

	/**
	 * Get the rotation (in degrees) for text on an axis with the given dimension
	 * so that the text will appear right-side-up
	 * @param {string} d The dimension to rotate for
	 */
	CINEMA_COMPONENTS.Glyph.prototype.getTextRotation = function(d) {
		var rot = this.rotation(d)*(180/Math.PI);
		return (rot > 90 && rot < 270) ? 180 : 0;
	}

})();'use strict';
(function() {
	/**
	 * CINEMA_COMPONENTS
	 * IMAGESPREAD
	 * 
	 * The ImageSpread Component for the CINEMA_COMPONENTS library.
	 * Contains the constructor for the ImageSpread Component
	 * Which displays image data for a set of rows in a database.
	 * 
	 * @exports CINEMA_COMPONENTS
	 * 
	 * @author Cameron Tauxe
	 */

	//If CINEMA_COMPONENTS is already defined, add to it, otherwise create it
	var CINEMA_COMPONENTS = {}
	if (window.CINEMA_COMPONENTS)
		CINEMA_COMPONENTS = window.CINEMA_COMPONENTS;
	else
		window.CINEMA_COMPONENTS = CINEMA_COMPONENTS;

	//Require that the Component module be included
	if (!CINEMA_COMPONENTS.COMPONENT_INCLUDED)
		throw new Error("CINEMA_COMPONENTS ImageSpread module requires that Component"+
			" module be included. Please make sure that Component module"+
			" is included BEFORE ImageSpread module");

	//Require that d3 be included
	if (!window.d3) {
		throw new Error("CINEMA_COMPONENTS ImageSpread module requires that"+
		" d3 be included (at least d3v4). Please make sure that d3 is included BEFORE the"+
		" the ImageSpread module");
	}

	/** @type {boolean} - Flag to indicate that the ImageSpread module has been included */
	CINEMA_COMPONENTS.IMAGE_SPREAD_INCLUDED = true;

	/**
	 * Constructor for ImageSpread Component
	 * Represents a component for viewing a spread of images from a selection of data
	 * @param {DOM} parent - The DOM object to build this component inside of 
	 * @param {CINEMA_COMPONENTS.Database} database - The database behind this component
	 * (Note that ImageSpread does not use a filterRegex)
	 */
	CINEMA_COMPONENTS.ImageSpread = function(parent, database) {
		var self = this;

		/***************************************
		 * SIZING
		 ***************************************/

		//Call super-constructor (will calculate size)
		CINEMA_COMPONENTS.Component.call(this,parent,database);

		/***************************************
		 * DATA
		 ***************************************/

		//override this.dimensions to include only FILE dimensions
		this.dimensions = this.dimensions.filter(function(d) {
			return (/^FILE/).test(d);
		});
		/** @type {boolean} Whether any FILE dimensions exist in the dataset */
		this.hasFileDimensions = this.dimensions.length != 0;

		/** @type {number[]} Inidices of all the data points to display */
		this.selection = [];

		/** @type {number} The page number currently being viewed*/
		this.currentPage = 1;

		/***************************************
		 * EVENTS
		 ***************************************/

		/** @type {d3.dispatch} Hook for events on chart
		 * Set handlers with on() function. Ex: this.dispatch.on('mouseover',handlerFunction(i))
		 * 'mouseover': Triggered when a set of images is moused over
		 *     (arguments are the index of moused over data and mouse event)
		*/
		this.dispatch = d3.dispatch('mouseover');

		/***************************************
		 * DOM Content
		 ***************************************/

		//Specify that this is an ImageSpread component
		d3.select(this.container).classed('IMAGE_SPREAD',true);

		//If there are no file dimensions, place a warning and stop here
		if (!this.hasFileDimensions) {
			this.noFileWarning = d3.select(this.container).append('div')
				.classed('noFileWarning',true)
				.text("No file information to display");
			return;
		}

		//NOTHING IN THE CONSTRUCTOR AFTER THIS POINT WILL BE EXECUTED 
		//IF THERE ARE NO FILE DIMENSIONS

		/** @type {d3.selection} The header/control panel */
		this.header = d3.select(this.container).append('div')
			.classed('header',true)
			.style('position','absolute')
			.style('width','100%');

		/** @type {d3.selection} The container for all the images */
		this.imageContainer = d3.select(this.container).append('div')
			.classed('imageContainer',true)
			.style('position','absolute')
			.style('width','100%')
			.style('overflow-y','auto');

		/***************************************
		 * HEADER/CONTROLS
		 ***************************************/

		//pageSize controls
		/** @type {d3.selection} The control panel for pageSize */
		this.pageSizeContainer = this.header.append('div')
			.classed('controlPanel pageSize',true);
		this.pageSizeContainer.append('span')
			.classed('label',true)
			.text("Results Per Page:");
		this.pageSizeContainer.append('br');
		/** @type {DOM (select)} The select node controlling page size */
		this.pageSizeNode = this.pageSizeContainer.append('select')
			.on('change',function() {
				self.updatePageNav();
				self.populateResults();
			})
			.node();
		//append options
		d3.select(this.pageSizeNode).selectAll('option')
			.data([10,25,50,100])
			.enter().append('option')
				.attr('value',function(d){return d;})
				.text(function(d){return d;});
		//Select 25 as default option
		d3.select(this.pageSizeNode).select('option[value="25"]')
			.attr('selected','true');

		//sort controls
		/** @type {d3.selection} The control panel for choosing sort dimension */
		this.sortContainer = this.header.append('div')
			.classed('controlPanel sort',true);
		this.sortContainer.append('span')
			.classed('label',true)
			.text("Sort By:");
		this.sortContainer.append('br');
		/** @type {DOM (select)} The select node controlling sort dimension */
		this.sortNode = this.sortContainer.append('select')
			.on('change',function() {
				self.selection.sort(self.getSortComparator());
				self.populateResults();
			})
			.node();
		//append options
		d3.select(this.sortNode).selectAll('option')
			.data(this.db.dimensions.filter(function(d){
				return !self.db.isStringDimension(d);
			}))
			.enter().append('option')
				.attr('value',function(d){return d;})
				.text(function(d){return d;});
		
		//sortOrder controls
		/** @type {d3.selection} The control panel for toggling sort order */
		this.sortOrderContainer = this.header.append('div')
			.classed('controlPanel sortOrder',true);
		this.sortOrderContainer.append('span')
			.classed('label',true)
			.text("Reverse Sort Order:");
		this.sortOrderContainer.append('br');
		/** @type {DOM (input/checkbox)} The node for toggling sort order */
		this.sortOrderNode = this.sortOrderContainer.append('input')
			.attr('type','checkbox')
			.on('input',function() {
				self.selection.sort(self.getSortComparator());
				self.populateResults();
			})
			.node();

		//imageSize controls
		/** @type {d3.selection} The control panel for controlling image size */
		this.imageSizeContainer = this.header.append('div')
			.classed('controlPanel imageSize',true);
		this.imageSizeContainer.append('span')
			.classed('label',true)
			.text("Image Size: 150px");
		this.imageSizeContainer.append('br');
		/** @type {DOM (input/range)} The node for adjusting imageSize */
		this.imageSizeNode = this.imageSizeContainer.append('input')
			.attr('type','range')
			.attr('min','100')
			.attr('max','500')
			.on('input',function() {
				d3.select(self.container).selectAll('.display')
					.style('width',this.value+'px');
				d3.select(self.container).select('.controlPanel.imageSize .label')
					.text("Image Size: "+this.value+"px");
			})
			.node();
		this.imageSizeNode.value = 150;

		//Update size
		this.updateSize();
	}
	//establish prototype chain
	CINEMA_COMPONENTS.ImageSpread.prototype = Object.create(CINEMA_COMPONENTS.Component.prototype);
	CINEMA_COMPONENTS.ImageSpread.prototype.constructor = CINEMA_COMPONENTS.ImageSpread;

	/**
	 * Should be called every time the size of the component's container changes.
	 * Updates the sizing of the imageSpread container
	 */
	CINEMA_COMPONENTS.ImageSpread.prototype.updateSize = function() {
		//Call super
		CINEMA_COMPONENTS.Component.prototype.updateSize.call(this);

		if (this.hasFileDimensions) {
			var headerSize = this.header.node().getBoundingClientRect().height;
			this.imageContainer
				.style('top',headerSize+'px')
				.style('height',(this.parentRect.height-headerSize)+'px');
		}
	};

	/**
	 * Set the data to be shown to the data represented with the given array of indices
	 */
	CINEMA_COMPONENTS.ImageSpread.prototype.setSelection =function(indices) {
		this.selection = indices;
		this.selection.sort(this.getSortComparator());
		this.updatePageNav();
		this.populateResults();
	}

	/**
	 * Get a comparator function for sorting the selection
	 * according to selected sort dimension and the sortOrder checkbox
	 */
	CINEMA_COMPONENTS.ImageSpread.prototype.getSortComparator = function() {
		var self = this;
		var d = this.sortNode.value;
		if (this.sortOrderNode.checked)
			return function(a,b) {
				if (self.db.data[a][d] === undefined) {return 1;}
				if (self.db.data[b][d] === undefined) {return -1;}
				if (isNaN(self.db.data[a][d])) {return 1};
				if (isNaN(self.db.data[b][d])) {return -1};
				return self.db.data[b][d] - self.db.data[a][d];
			}
		else
			return function(a,b) {
				if (self.db.data[a][d] === undefined) {return -1;}
				if (self.db.data[b][d] === undefined) {return 1;}
				if (isNaN(self.db.data[a][d])) {return -1};
				if (isNaN(self.db.data[b][d])) {return 1};
				return self.db.data[a][d] - self.db.data[b][d];
			}
	}

	/**
	 * Fill the imageContainer with dataDisplays for the current page of results
	 */
	CINEMA_COMPONENTS.ImageSpread.prototype.populateResults = function() {
		var self = this;
		if (this.hasFileDimensions) {
			var pageSize = this.pageSizeNode.value;
			var pageData = this.selection.slice((this.currentPage-1)*pageSize,
											Math.min(this.currentPage*pageSize,this.selection.length));
			//Bind pageData and update dataDisplays
			var displays = this.imageContainer.selectAll('.dataDisplay')
				.data(pageData);
			displays.exit().remove(); //remove unused dataDisplays
			displays.enter() //add new dataDisplays
				.append('div').classed('dataDisplay',true)
			.merge(displays) //update
				//Set up mouse events
				.on('mouseenter',function(d) {
					self.dispatch.call('mouseover',self,d,d3.event);
				})
				.on('mouseleave',function(d) {
					self.dispatch.call('mouseover',self,null,d3.event);
				})
				//For each data display, create file displays for every file in it
				.each(function(d) {
					var files = self.dimensions.map(function(dimension) {
						return self.db.data[d][dimension];
					});
					//bind files data
					var fileDisplays = d3.select(this).selectAll('.fileDisplay')
						.data(files);
					fileDisplays.exit().remove();
					var ENTER = fileDisplays.enter().append('div')
						.classed('fileDisplay',true);
					ENTER.append('div').classed('display',true)
						.style('width',self.imageSizeNode.value+'px');
					ENTER.append('div').classed('displayLabel',true);
					var UPDATE = ENTER.merge(fileDisplays)
						//Create content of each file display
						.each(function(f,i) {
							d3.select(this).select('.display').html('');
							//Create an image in the display if the it is an image filetype
							if (isValidFiletype(getFileExtension(f)))
								d3.select(this).select('.display')
									.classed('image',true)
									.classed('text',false)
									.append('img')
										.attr('src',self.db.directory+'/'+f)
										.attr('width', '100%')
										.on('click',self.createModalImg);
							//Otherwise create an error message
							else
								d3.select(this).select('.display')
									.classed('text',true)
									.classed('image',false)
									.append('div')
										.attr('class','resultErrorText')
										.text('Cannot display file: ' + f);
							//Update label
							d3.select(this).select('.displayLabel')
								.text(self.dimensions[i]);
						});
				});
		}
	};

	/**
	 * An event handler for an image that will create a modal overlay
	 * of the image when clicked
	 */
	CINEMA_COMPONENTS.ImageSpread.prototype.createModalImg = function() {
		d3.select('body').append('div')
		.attr('class', 'modalBackground')
		.on('click', function() {
			//clicking the modal removes it
			d3.select(this).remove();
		})
		.append('img')
			.attr('class', 'modalImg')
			.attr('src',d3.select(this).attr('src'));
	}

	/**
	 * Calculate the number of pages needed to show all results and rebuild
	 * the page navigation widget.
	 */
	CINEMA_COMPONENTS.ImageSpread.prototype.updatePageNav = function() {
		var self = this;
		d3.select(this.container).select('.pageNavWrapper').remove(); //remove previous widget
		var pageSize = this.pageSizeNode.value;
		//If there are more results than can fit on one page, build a pageNav widget
		if (this.selection.length > pageSize) {
			//calculate number of pages needed
			var numPages = Math.ceil(this.selection.length/pageSize);
			//If the currently selected page is higher than the new number of pages, set to last page
			if (this.currentPage > numPages) {this.currentPage = numPages};
			//Add pageNav and buttons
			d3.select(this.container).append('div')
				.classed('pageNavWrapper',true)
			.append('ul')
				.classed('pageNav',true)
				.selectAll('li')
					//Get data for which buttons to build, then build
					.data(getPageButtons(numPages,this.currentPage))
					.enter().append('li')
						.classed('pageButton',true)
						.attr('mode', function(d) {
							return d.page == self.currentPage ? 'selected': 'default';
						})
						.text(function(d) {return d.text;})
						.on('click',function(d) {
							if (d3.select(this).attr('mode') != 'selected') {
								self.currentPage = d.page;
								if (d.do_rebuild) {
									self.updatePageNav();
									self.populateResults();
								}
								else {
									d3.select(self.container).select('.pageButton[mode="selected"]')
										.attr('mode','default');
									d3.select(this).attr('mode','selected');
									d3.select('.pageReadout').text(self.currentPage + " / " + numPages);
									self.populateResults();
								}
							}
						});
			//Add readout of currentPage/totalPages
			d3.select('.pageNavWrapper').append('div')
				.classed('pageReadout',true)
				.text(this.currentPage + " / " + numPages);
		} //end if (this.selection.length > pageSize)
		//Otherwise, don't build a widget and go to first (only) page
		else {
			this.currentPage = 1;
		}
	}

	/**
	 * Given the number of pages needed and the currently selected page, return
	 * a list of objects represented the pageNav buttons to show
	 * objects are formatted like so:
	 * {text: [button_text],
	 * page: [pageNumber to link to], 
	 * do_rebuild: [whether or not the pageNav widget should be rebuilt when this button is clicked]}
	**/
	function getPageButtons(numPages, current) {
		//If there are 7 or fewer pages, create a widget with a button for each page ([1|2|3|4|5|6|7])
		if (numPages <= 7) {
			var pageData = [];
			for (var i = 0; i < numPages; i++)
				pageData.push({text: i+1, page: i+1, do_rebuild: false});
			return pageData;
		}
		//Otherwise, create a widget with buttons for navigating relative to selected page ([|<|<<|10|20|30|>>|>|])
		else {
			//step size is one order of magnitude below the total number of pages
			var stepSize = Math.pow(10,Math.round(Math.log10(numPages)-1));
			var pageData = [];
			//Create buttons for selecting lower pages if current is not already one
			if (current != 1) {
				pageData.push({text: "|<", page: 1, do_rebuild: true});
				pageData.push({text: "<", page: current-1, do_rebuild: true});
				var prevStep = current-stepSize >= 1 ? current-stepSize : current-1;
				pageData.push({text: prevStep, page: prevStep, do_rebuild: true});
			}
			//Create button for currently selected page
			pageData.push({text: current, page: current, do_rebuild: false});
			//Create buttons for selecting higher pages if current is not already at the end
			if (current != numPages) {
				var nextStep = current+stepSize <= numPages ? current+stepSize : current+1;
				pageData.push({text: nextStep, page: nextStep, do_rebuild: true});
				pageData.push({text: ">", page: current+1, do_rebuild: true});
				pageData.push({text: ">|", page: numPages, do_rebuild: true});
			}
			return pageData;
		}
	}

	//Get if the given filetype is a valid image filetype
	function isValidFiletype(type) {
		if (!type)
			return false;
		var validFiletypes = ['JPG','JPEG','PNG','GIF'];
		type = type.trimLeft().trimRight();
		var index = validFiletypes.indexOf(type.toUpperCase()); 
	
		return (index >= 0);
	}
	
	//Get the extension/filetype of the given path
	function getFileExtension(path) {
		return path ? path.substr(path.lastIndexOf('.')+1).trimRight() : undefined;
	}

})();'use strict';
(function() {
	/**
	 * CINEMA_COMPONENTS
	 * PCOORD
	 * 
	 * The Pcoord Component for the CINEMA_COMPONENTS library.
	 * Contains the constructor for Parallel Coordinates Components (e.g. PcoordSVG, PcoordCanvas)
	 * It is a sublcass of Component and contains methods and fields common to all Parallel Coordinates Components
	 * 
	 * @exports CINEMA_COMPONENTS
	 * 
	 * @author Cameron Tauxe
	 */

	//If CINEMA_COMPONENTS is already defined, add to it, otherwise create it
	var CINEMA_COMPONENTS = {}
	if (window.CINEMA_COMPONENTS)
		CINEMA_COMPONENTS = window.CINEMA_COMPONENTS;
	else
		window.CINEMA_COMPONENTS = CINEMA_COMPONENTS;

	//Require that the Component module be included
	if (!CINEMA_COMPONENTS.COMPONENT_INCLUDED)
		throw new Error("CINEMA_COMPONENTS Pcoord module requires that Component"+
			" module be included. Please make sure that Component module"+
			" is included BEFORE Pcoord module");

	//Require that d3 be included
	if (!window.d3) {
		throw new Error("CINEMA_COMPONENTS Pcoord module requires that"+
		" d3 be included (at least d3v4). Please make sure that d3 is included BEFORE the"+
		" the Pcoord module");
	}

	/** @type {boolean} - Flag to indicate that the Pcoord module has been included */
	CINEMA_COMPONENTS.PCOORD_INCLUDED = true;

	/**
	 * Abstract constructor for Pcoord Components
	 * Represents a component for displaying and interacting with a database on a parallel coordinates chart
	 * Objects such as PcoordSVG and PcoordCanvas inherit from this
	 * @param {DOM} parent - The DOM object to build this component inside of
	 * @param {CINEMA_COMPONENTS.Database} database - The database behind this component
	 * @param {RegExp} filterRegex - A regex to determine which dimensions to NOT show on the component
	 */
	CINEMA_COMPONENTS.Pcoord = function(parent, database, filterRegex) {
		if (this.constructor === CINEMA_COMPONENTS.Pcoord)
			throw new Error("Cannot instantiate abstract class 'Pcoord'"+
			" Please use a subclass");

		var self = this;

		/***************************************
		 * SIZING
		 ***************************************/
		
		/** @type {CINEMA_COMPONENTS.Margin} Override default margin */
		this.margin = new CINEMA_COMPONENTS.Margin(30,10,10,10);
		/** @type {number} the room left at the bottom of the chart for NaN values */
		this.NaNMargin;

		//call super-constructor
		CINEMA_COMPONENTS.Component.call(this,parent,database,filterRegex);
		//after size is calculated in the super-constructor, Set NaNMargin
		this.NaNMargin = this.internalHeight/11;

		/***************************************
		 * DATA
		 ***************************************/

		/** @type {number[]} Indices of all currently selected data */
		this.selection = d3.range(0,this.db.data.length);
		/** @type {number} Indices of all currently highlighted data*/
		this.highlighted = [];
		/** @type {CINEMA_COMPONENTS.ExtraData[]} Custom data to overlay on chart */
		this.overlayData = [];

		/***************************************
		 * EVENTS
		 ***************************************/

		/** @type {d3.dispatch} Hook for events on chart
		 * Set handlers with on() function. Ex: this.dispatch.on('click',handlerFunction(i))
		 * 'selectionchange': Triggered when selection of data changes
		 *     (called with array of indices of selected data)
		 * 'mouseover': Triggered when a path is moused over
		 *     (called with index of moused over data and reference to mouse event)
		 * 'click': Triggered when a path is clicked on
		 *     (called with index of clicked data and reference to mouse event)
		 * 'axisorderchange': Triggered when the axis ordering is manually changed
		 *     (called with the list of the dimensions in the new order)
		 */
		this.dispatch = d3.dispatch("selectionchange","mouseover","click","axisorderchange");

		/***************************************
		 * SCALES
		 ***************************************/

		/** @type {d3.scalePoint} - Scale for x axis on chart
		 * Maps dimensions to position (in pixels) along width of chart.*/
		this.x = d3.scalePoint()
			.domain(this.dimensions)
			.range([0,this.internalWidth])
			.padding(1);;

		/** @type {Object(d3.scale)} 
		 * Scales for each dimension axis on the chart. One scale for each dimension */
		this.y = {};
		this.dimensions.forEach(function (d) {
			//Create point scale for string dimensions
			if (self.db.isStringDimension(d)) {
				if (!self.y[d]) {
					self.y[d] = d3.scalePoint();
				}
				self.y[d].domain(self.db.dimensionDomains[d])
					.range([self.internalHeight,0]);
			}
			//Create linear scale for numeric dimensions
			else {
				if (!self.y[d]) {
					self.y[d] = d3.scaleLinear();
				}
				self.y[d].domain(self.db.dimensionDomains[d])
					.range([self.internalHeight-self.NaNMargin,0]);
			}
		});

		/***************************************
		 * DRAGGING
		 ***************************************/

		/** @type {Object (numbers)} Keeps track of the x-position of each axis currently being dragged */
		this.dragging = {};

		//Drag event handlers
		this.axisDragStart = function(d) {
			self.dragging[d] = self.x(d);
		};
		this.axisDrag = function(d) {
			self.dragging[d] = Math.min(self.internalWidth,Math.max(0,d3.event.x));
			self.redrawPaths();
			var oldDimensions = self.dimensions.slice();
			self.dimensions.sort(function(a,b){
				return self.getXPosition(a)-self.getXPosition(b);
			});
			if (!arraysEqual(oldDimensions,self.dimensions))
				self.dispatch.call('axisorderchange',self,self.dimensions);
			self.x.domain(self.dimensions);
			self.axes.attr('transform',function(d) {
				return "translate("+self.getXPosition(d)+")";
			});
		};
		this.axisDragEnd = function(d) {
			delete self.dragging[d];
			d3.select(this).attr('transform',"translate("+self.x(d)+")");
			self.redrawPaths();
		};

		/** @type {d3.drag} */
		this.drag = d3.drag()
			.subject(function(d){return {x: self.x(d)};})
			.on('start',this.axisDragStart)
			.on('drag',this.axisDrag)
			.on('end',this.axisDragEnd);

		/***************************************
		 * BRUSHES
		 ***************************************/

		 /** @type {Object (Arrays)} Keeps track of the extents of the brush for each dimension*/
		this.brushExtents = {}

		/** @type {boolean} If true, don't update selection when brushes change */
		this.dontUpdateSelectionOnBrush = false;

		//Brush event handler
		this.axisBrush = function(d) {
			//If this is called due to an event (as opposed to manually called)
			//update corresponding brush extent
			if (d3.event != null) {
				self.brushExtents[d] = d3.event.selection;
				//Ignore brush if its start and end coordinates are the same
				if (self.brushExtents[d] != null && self.brushExtents[d][0] === self.brushExtents[d][1])
					delete self.brushExtents[d];
			}
			if (!self.dontUpdateSelectionOnBrush)
				self.updateSelection();
		}

		/** @type {d3.brushY} The brushes for each axis */
		this.brush = d3.brushY()
			.extent([[-8,0],[8,this.internalHeight]])
			.on('start', function(){d3.event.sourceEvent.stopPropagation();})
			.on('start brush',this.axisBrush);

		/***************************************
		 * DOM Content
		 ***************************************/

		//Create DOM content
		//Specify that this is a Pcoord component
		d3.select(this.container).classed('PCOORD',true);
		/** @type {d3.selection} Where the paths for the chart will be drawn
		 * The actual drawing of paths depends on the specific Pcoord subclass
		 */
		this.pathContainer = d3.select(this.container).append('div')
			.classed('pathContainer',true)
			.style('position','absolute')
			.style('width',this.parentRect.width+'px')
			.style('height',this.parentRect.height+'px');

		/** @type {boolean} Indicates if the lines on the chart should be smooth(curved) or not 
		 * Be sure to call redrawPaths() after changing this so it takes effect
		*/
		this.smoothPaths = true;

		/***************************************
		 * AXES
		 ***************************************/

		/** @type {d3.selection} The container for all axes (as an svg object) */
		this.axisContainer = d3.select(this.container).append('svg')
			.classed('axisContainer',true)
			.style('position','absolute')
			.attr('viewBox',(-this.margin.right)+' '+(-this.margin.top)+' '+
							(this.parentRect.width)+' '+
							(this.parentRect.height))
			.attr('preserveAspectRatio','none')
			.attr('width','100%')
			.attr('height','100%')
			//disable pointer events on axisContainer so it doesn't block pathContainer
			.style('pointer-events','none');
		/** @type {d3.selction} Groups for each axis */
		this.axes = this.axisContainer.selectAll('.axisGroup')
			.data(this.dimensions)
		.enter().append('g')
			.classed('axisGroup',true)
			.attr('transform', function(d) {
				return "translate("+self.x(d)+")";
			})
			.call(this.drag)
		//Add d3 axes to each axis group
		this.axes.append('g')
			.classed('axis',true)
			.each(function(d) {
				d3.select(this).call(d3.axisLeft().scale(self.y[d]));
				if (!self.db.isStringDimension(d))
					self.addNaNExtensionToAxis(this);
			})
		.append('text')
			.classed('axisTitle',true)
			//allow pointer-events on axisTitle so axes can be dragged
			.style('pointer-events','initial')
			.style('text-anchor','middle')
			.attr('y',-9)
			.text(function(d){return d;});
		//Add brush group to each axis group
		this.axes.append('g')
			.classed('brush',true)
			.each(function(){d3.select(this).call(self.brush);});

	};
	//establish prototype chain
	CINEMA_COMPONENTS.Pcoord.prototype = Object.create(CINEMA_COMPONENTS.Component.prototype);
	CINEMA_COMPONENTS.Pcoord.prototype.constructor = CINEMA_COMPONENTS.Pcoord;

	/**
	 * Add an additional line segment and tick to the end of an axis to represent the area
	 * for NaN values.
	 * @param {DOM} node - The DOM node for the svg group containing the axis (g.axis)
	 */
	CINEMA_COMPONENTS.Pcoord.prototype.addNaNExtensionToAxis = function(node) {
		d3.select(node).append('path')
			.attr('class','NaNExtension')
			.attr('d',"M0.5,"+String(this.internalHeight-this.NaNMargin+0.5)+"V"+String(this.internalHeight-0.5));
		var NaNTick = d3.select(node).append('g')
			.attr('class','NaNExtensionTick')
			.attr('transform',"translate(0,"+String(this.internalHeight-0.5)+")");
		NaNTick.append('line')
			.attr('x2','-6');
		NaNTick.append('text')
			.attr('x','-9')
			.attr('dy','0.32em')
			.text('NaN');
	}

	/**
	 * Should be called every time the size of the chart's container changes.
	 * Updates the sizing and scaling of all parts of the chart and redraws
	 */
	CINEMA_COMPONENTS.Pcoord.prototype.updateSize = function() {
		var self = this;
		var oldHeight = this.internalHeight;//old height needed to rescale brushes

		//Call super (will recalculate size)
		CINEMA_COMPONENTS.Component.prototype.updateSize.call(this);

		//update NaNMargin
		this.NaNMargin = this.internalHeight/11;

		//update PathContainer size
		this.pathContainer
			.style('width',this.parentRect.width+'px')
			.style('height',this.parentRect.height+'px');

		//Rescale x
		this.x.range([0,this.internalWidth]);

		//Rescale y scales
		this.dimensions.forEach(function(d) {
			self.y[d].range([self.db.isStringDimension(d) ? self.internalHeight : self.internalHeight-self.NaNMargin, 0]);
		});

		this.redrawPaths();

		//Reposition and rescale axes
		this.axisContainer
			.attr('viewBox',(-this.margin.right)+' '+(-this.margin.top)+' '+
						(this.parentRect.width)+' '+
						(this.parentRect.height));
		this.axes.attr("transform", function(d) {
			return "translate("+self.getXPosition(d)+")";
		});
		this.axes.each(function(d) {
			d3.select(this).call(d3.axisLeft().scale(self.y[d]));
			//if scale is linear, then update the NaN extension on the axis
			if (!self.db.isStringDimension(d)) {
				d3.select(this).select('path.NaNExtension')
					.attr('d',"M0.5,"+String(self.internalHeight-self.NaNMargin+0.5)+"V"+String(self.internalHeight-0.5));
				d3.select(this).select('.NaNExtensionTick')
					.attr('transform',"translate(0,"+String(self.internalHeight-0.5)+")");
			}
		});

		//Redraw brushes
		this.dontUpdateSelectionOnBrush = true; //avoid updating selection when resizing brushes
		this.brush.extent([[-8,0],[8,this.internalHeight]]);
		this.axes.selectAll('g.brush').each(function(d) {
			d3.select(this).call(self.brush);
			d3.select(this).call(self.brush.move, function() {
				if (self.brushExtents[d] == null)
					return null;

				return self.brushExtents[d].map(function(i) {
					return i/oldHeight * self.internalHeight;
				});
			});
		});
		this.dontUpdateSelectionOnBrush = false;
	}

	/**
	 * Called whenever a brush changes the selection
	 * Updates selection to hold the indices of all data points that are
	 * selected by the brushes.
	 * @param {bool} force - If true, selectionchange event will be triggered
	 * 	and paths will be redrawn even if the set the of selected points did
	 * 	not change.
	 */
	CINEMA_COMPONENTS.Pcoord.prototype.updateSelection = function(force) {
		var self = this;
		var newSelection = [];
		this.db.data.forEach(function(d,i) {
			var selected = true;
			for (var p in self.dimensions) {
				var extent = self.brushExtents[self.dimensions[p]];
				if (extent) {
					var y = self.getYPosition(self.dimensions[p],d);
					selected = selected && extent[0] <= y && y <= extent[1];
					if (!selected)
						break;
				}
			}
			if (selected)
				newSelection.push(i);
		});
		if (!arraysEqual(this.selection,newSelection) || force) {
			this.selection = newSelection;
			this.dispatch.call("selectionchange",this, this.selection.slice());
			this.redrawSelectedPaths();
		}
	}

	/**
	 * Set the indices of the currently highlighted data
	 */
	CINEMA_COMPONENTS.Pcoord.prototype.setHighlightedPaths = function(indices) {
		this.highlighted = indices;
		this.redrawHighlightedPaths();
	}

	/**
	 * Set the current overlay paths
	 */
	CINEMA_COMPONENTS.Pcoord.prototype.setOverlayPaths = function(data) {
		this.overlayData = data;
		this.redrawOverlayPaths();
	};

	//Shortcut function for redrawSelectedPaths, redrawHighlightedPath, redrawOverlayPaths
	CINEMA_COMPONENTS.Pcoord.prototype.redrawPaths = function() {
		this.redrawSelectedPaths();
		this.redrawHighlightedPaths();
		this.redrawOverlayPaths();
	}

	/**
	 * Set the chart's selection to encapsulate the data represented by
	 * the given array of indices
	 */
	CINEMA_COMPONENTS.Pcoord.prototype.setSelection = function(selection) {
		var ranges = {};
		var self = this;
		this.dimensions.forEach(function(d) {
			ranges[d] = d3.extent(selection, function(i) {
				return self.getYPosition(d, self.db.data[i]);
			});
		});
		this.axes.selectAll('g.brush')
			.each(function(d) {
				d3.select(this).call(self.brush.move, function() {
					return [ranges[d][0]-5,ranges[d][1]+5];
				});
			});
		//call brush event handler
		this.axisBrush();
	}

	/**
	 * Reorder the axes to the order given
	 */
	CINEMA_COMPONENTS.Pcoord.prototype.setAxisOrder = function(order) {
		var self = this;
		//filter out dimensions in order, but not in chart's dimensions
		var order = order.filter(function(d) {
			return self.dimensions.includes(d);
		});
		//Add any dimensions in chart's dimensions but not in order
		this.dimensions.forEach(function(d) {
			if (!order.includes[d])
				order.push(d);
		});
		//update domain
		this.x.domain(order);
		//update dimensions list
		self.dimensions.sort(function(a,b){
			return self.getXPosition(a)-self.getXPosition(b);
		});
		//update axes
		this.axes.attr('transform',function(d) {
			return "translate("+self.getXPosition(d)+")";
		});
		//redraw
		this.redrawPaths();
	}

	/**
	 * Redraw the current selection of paths.
	 * Actual implementation is up to specific subclasses
	 */
	CINEMA_COMPONENTS.Pcoord.prototype.redrawSelectedPaths = function() {
		throw new Error("Cannot call abstract function 'redrawSelectedPaths()'!"+
			" Please override function in a subclass");
	}

	/**
	 * Redraw the currently highlighted path.
	 * Actual implementation is up to specific subclasses
	 */
	CINEMA_COMPONENTS.Pcoord.prototype.redrawHighlightedPaths = function() {
		throw new Error("Cannot call abstract function 'redrawHighlightedPaths()'!"+
			" Please override function in a subclass");
	}

	/**
	 * Redraw the overlay paths.
	 * Actual implementation is up to specific subclasses
	 */
	CINEMA_COMPONENTS.Pcoord.prototype.redrawOverlayPaths = function() {
		throw new Error("Cannot call abstract function 'redrawOverlayPaths()'!"+
			" Please override function in a subclass");
	}

	/**
	 * Get the path (the contents of the 'd' attribute) for the path
	 * represented by the given data point.
	 * Draws a physical break in the path where values are undefined.
	 * @param {Object} d The data point to base the path off
	 */
	CINEMA_COMPONENTS.Pcoord.prototype.getPath = function(d) {
		var self = this;
		var curveLength = this.smoothPaths ? this.internalWidth/this.dimensions.length/3 : 0;
		var singleSegmentLength = this.internalWidth/this.dimensions.length/5;
		var path = '';

		//Split dimensions into sections deliminated by undefined values
		var sections = [];
		var currentSection = [];
		this.dimensions.forEach(function(p) {
			if (d[p] != undefined) {
				currentSection.push(p);
			}
			else if (currentSection.length != 0) {
				sections.push(currentSection.slice());
				currentSection = [];
			}
		});
		if (currentSection.length > 0)
			sections.push(currentSection.slice());

		//Draw individual sections
		sections.forEach(function(section) {
			//If a section contains only one dimension, draw a short line across the axis
			if (section.length == 1) {
				var p = section[0];
				var x = self.getXPosition(p);
				var y = self.getYPosition(p,d);
				path += ('M '+(x-singleSegmentLength/2)+' '+y+' L ')+
						((x+singleSegmentLength/2)+' '+y);
			}
			else {
				section.forEach(function (p,i) {
					var x = self.getXPosition(p);
					var y = self.getYPosition(p,d);
					if (i == 0) {//beginning of path
						path += ('M '+x+' '+y+' C ')+
								((x+curveLength)+' '+y+' ');
					}
					else if (i == section.length-1) {//end of path
						path += ((x-curveLength)+' '+y+' ')+
								(x+' '+y+' ');
					}
					else {//midpoints
						path += ((x-curveLength)+' '+y+' ')+
								(x+' '+y+' ')+
								((x+curveLength)+' '+y+' ');
					}
				});
			}
		});
		return path;
	}

	/**
	 * Get the x-coordinate of the axis representing the given dimension
	 * @param {string} d - The dimension to get the x-coordinate for
	 */
	CINEMA_COMPONENTS.Pcoord.prototype.getXPosition = function(d) {
		var v = this.dragging[d];
		return v == null ? this.x(d) : v;
	};

	/**
	 * Get the y-coordinate of the line for data point p on dimension d
	 * @param {string} d - The dimension on the data point
	 * @param {Object} p - The data point
	 */
	CINEMA_COMPONENTS.Pcoord.prototype.getYPosition = function(d, p) {
		if (!this.db.isStringDimension(d) && isNaN(p[d]))
			//If the value is NaN on a linear scale, return internalHeight as the position 
			//(to place the line on the NaN tick)
			return this.internalHeight;
		return this.y[d](p[d]);
	}

	/**
	 * Convenience function to compare arrays
	 * (used to compare the selection to the previous one)
	 */
	function arraysEqual(a, b) {
		if (a === b) return true;
		if (a == null || b == null) return false;
		if (a.length != b.length) return false;

		for (var i = 0; i < a.length; ++i) {
			if (a[i] !== b[i]) return false;
		}
		return true;
	}

})();'use strict';
(function() {
	/**
	 * CINEMA_COMPONENTS
	 * PCOORD_CANVAS
	 * 
	 * The PcoordSVG Component for the CINEMA_COMPONENTS library.
	 * Contains the constructor for the PcoordCanvas component:
	 * A subclass of Pcoord which draws a Paralell Coordinates chart using canvas elements.
	 * 
	 * @exports CINEMA_COMPONENTS
	 * 
	 * @author Cameron Tauxe
	 */

	//If CINEMA_COMPONENTS is already defined, add to it, otherwise create it
	var CINEMA_COMPONENTS = {}
	if (window.CINEMA_COMPONENTS)
		CINEMA_COMPONENTS = window.CINEMA_COMPONENTS;
	else
		window.CINEMA_COMPONENTS = CINEMA_COMPONENTS;

	//Require that the Pcoord Component be included
	if (!CINEMA_COMPONENTS.PCOORD_INCLUDED)
		throw new Error("CINEMA_COMPONENTS PcoordCanvas Component requires that Pcoord"+
			" component be included. Please make sure that Pcoord component"+
			" is included BEFORE PcoordCanvas module");

	/** @type {boolean} - Flag to indicate that the PcoordCanvas Component has been included */
	CINEMA_COMPONENTS.PCOORD_CANVAS_INCLUDED = true;

	/**
	 * Constructor for PcoordCanvas Component
	 * Represents a component for displaying and interacting with a database on a parallel coordinates chart
	 * rendered with canvas elements
	 * @param {DOM} parent - The DOM object to build this component inside of
	 * @param {CINEMA_COMPONENTS.Database} database - The database behind this component
	 * @param {RegExp} filterRegex - A regex to determine which dimensions to NOT show on the component
	 */
	CINEMA_COMPONENTS.PcoordCanvas = function(parent, database, filterRegex) {
		var self = this;
		//call super-constructor
		CINEMA_COMPONENTS.Pcoord.call(this,parent,database,filterRegex);

		//Specify that this is a Pcoord Canvas component
		d3.select(this.container).classed('CANVAS',true);

		//Add canvases to pathContainer
		this.selectedCanvas = this.pathContainer.append('canvas')
			.classed('selectedCanvas',true)
			.node();
		this.highlightedCanvas = this.pathContainer.append('canvas')
			.classed('highlightedCanvas',true)
			.node();
		this.overlayCanvas = this.pathContainer.append('canvas')
			.classed('overlayCanvas',true)
			.node();
		//Index canvas is invisible and draws in a unique color for each path
		//Its color data is used to determine which path is being moused over
		this.indexCanvas = this.pathContainer.append('canvas')
			.classed('indexCanvas',true)
			.style('display','none')
			.node();
		//Size/position canvases
		this.pathContainer.selectAll('canvas')
			.style('position','absolute')
			.style('top',this.margin.top+'px')
			.style('left',this.margin.left+'px');

		//Determine screen DPI to rescale canvas contexts
		//(prevents artifacts and blurring on some displays)
		//https://stackoverflow.com/a/15666143/2827258
		this.pixelRatio = (function() {
			var ctx = document.createElement('canvas').getContext("2d"),
				dpr = window.devicePixelRatio || 1,
				bsr = ctx.webkitBackingStorePixelRatio ||
						ctx.mozBackingStorePixelRatio ||
						ctx.msBackingStorePixelRatio ||
						ctx.oBackingStorePixelRatio ||
						ctx.backingStorePixelRatio || 1;
				return dpr / bsr;
		})();

		//Loading/still drawing indicator
		this.loading = d3.select(this.container).append('div')
			.classed('loadingIndicator',true)
			.style('display','none')
			.text('Drawing...');

		//Set an interval to call drawIterator if it exists
		//roughly 60 times a second
		this.interval = setInterval(function(self) {
			for (var i = 0; i < 25; i++) {
				if (self.drawIterator) {
					if (self.drawIterator.next().done) {
						self.drawIterator = undefined;
						self.loading.style('display','none');
					}
				}
			}
		}, 16, this);

		//Set up mousemove listener to get moused-over paths
		this.lastMouseMove = null; //remember last result, to prevent excessive dispatch calls
		this.pathContainer.on('mousemove', function() {
			var x = d3.mouse(self.selectedCanvas)[0]*self.pixelRatio;
			var y = d3.mouse(self.selectedCanvas)[1]*self.pixelRatio;
			if (x >= 0 && y >= 0) {
				var index = getIndexAtPoint(x,y,self.indexCanvas);
				if (index != -1) {
					if (self.lastMouseMove != self.selection[index]) {
						self.lastMouseMove = self.selection[index];
						self.dispatch.call('mouseover',self,self.selection[index],d3.event);
					}
				}
				else {
					if (self.lastMouseMove !== null) {
						self.lastMouseMove = null;
						self.dispatch.call('mouseover',self,null,d3.event);
					}
				}
			}
		});

		this.updateSize();
	}
	//establish prototype chain
	CINEMA_COMPONENTS.PcoordCanvas.prototype = Object.create(CINEMA_COMPONENTS.Pcoord.prototype);
	CINEMA_COMPONENTS.PcoordCanvas.prototype.constructor = CINEMA_COMPONENTS.PcoordCanvas;

	/**************************
	 * OVERRIDE METHODS
	 **************************/

	CINEMA_COMPONENTS.PcoordCanvas.prototype.updateSize = function() {
		var self = this;
		//call super
		CINEMA_COMPONENTS.Pcoord.prototype.updateSize.call(this);

		//Resize canvases
		this.pathContainer.selectAll('canvas')
			.style('width',this.internalWidth+'px')
			.style('height',this.internalHeight+'px')
		// width/height styles are distinct from attributes
		// (attributes determine context size, style is the size the canvas appears in on screen)
			.attr('width',this.internalWidth*this.pixelRatio+'px')
			.attr('height',this.internalHeight*this.pixelRatio+'px')
			.each(function(){
				this.getContext('2d').scale(self.pixelRatio,self.pixelRatio);
			});
		//Init canvas contexts
		var selectedContext = this.selectedCanvas.getContext('2d');
		selectedContext.strokeStyle = 'lightgray';
		selectedContext.globalAlpha = 0.3;
		selectedContext.lineWidth = 2;
		var highlightedContext = this.highlightedCanvas.getContext('2d');
		highlightedContext.strokeStyle = 'lightskyblue';
		highlightedContext.lineWidth = 4;
		var indexContext = this.indexCanvas.getContext('2d');
		indexContext.lineWidth = 3;

		this.redrawPaths();
	}

	/**
	 * Redraw the current selection of paths.
	 */
	CINEMA_COMPONENTS.PcoordCanvas.prototype.redrawSelectedPaths = function() {
		var self = this;

		var ctx = this.selectedCanvas.getContext('2d');
		ctx.clearRect(0,0,this.internalWidth,this.internalHeight);

		var indexCtx = this.indexCanvas.getContext('2d');
		indexCtx.clearRect(0,0,this.internalWidth,this.internalHeight);

		this.drawIterator = (function*(queue){
			self.loading.style('display','initial');
			var i = 0;
			while (i < queue.length) {
				var path = new Path2D(self.getPath(self.db.data[queue[i]]));
				ctx.stroke(path);

				indexCtx.strokeStyle = indexToColor(i);
				indexCtx.stroke(path);

				yield ++i;
			}
		})(this.selection);
	}

	/**
	 * Redraw the currently highlighted path.
	 */
	CINEMA_COMPONENTS.PcoordCanvas.prototype.redrawHighlightedPaths = function() {
		var self = this;

		var ctx = this.highlightedCanvas.getContext('2d');
		ctx.clearRect(0,0,this.internalWidth,this.internalHeight);

		this.highlighted.forEach(function(d) {
			var path = new Path2D(self.getPath(self.db.data[d]));
			ctx.stroke(path);
		});
	}

	/**
	 * Redraw the overlay paths.
	 */
	CINEMA_COMPONENTS.PcoordCanvas.prototype.redrawOverlayPaths = function() {
		var self = this;

		var ctx = this.overlayCanvas.getContext('2d');
		ctx.clearRect(0,0,this.internalWidth,this.internalHeight);

		this.overlayData.forEach(function(d) {
			//Parse style
			ctx.lineWidth = d.style.lineWidth || 1;
			ctx.lineCap = d.style.lineCap || 'butt';
			ctx.lineJoin = d.style.lineJoin || 'miter';
			ctx.miterLimit = d.style.miterLimit || 10;
			ctx.strokeStyle = d.style.strokeStyle || 'black';
			if (d.style.lineDash)
				ctx.setLineDash(d.style.lineDash);
			else
				ctx.setLineDash([]);
			//Draw line
			var path = new Path2D(self.getPath(d.data));
			ctx.stroke(path);
		})
	}

	/**
	 * Override destroy() to also clear interval
	 */
	CINEMA_COMPONENTS.PcoordCanvas.prototype.destroy = function() {
		clearInterval(this.interval);
		//Call super
		CINEMA_COMPONENTS.Component.prototype.destroy.call(this);
	}

	//Get the index of the path at the given point
	//using the colors on the index canvas
	//returns -1 if there is no path, or the area around the point is too noisy
	var getIndexAtPoint = function(x,y,canvas) {
		//get the color data for a 3x3 pixel area around the point
		var colorData = canvas.getContext('2d').getImageData(x-1,y-1,3,3).data;
		//get the index for each pixel
		var indices = [];
		for (var i = 0; i < colorData.length/4; i++) {
			indices.push(colorToIndex(colorData.slice(i*4,i*4+3)));
		}

		//for a positive match, must find at least 5 pixels with the same index
		indices.sort();
		var matched = -1;
		var count = 0;
		var counting = -1;
		for (var i = 0; i < indices.length; i++) {
			if (counting != indices[i]) {
				count = 1;
				counting = indices[i];
			}
			else {
				count++;
				if (count == 5) {
					matched = counting;
					break;
				}
			}
		}

		return matched;
	}

	//convert an index value to a color
	//Mapping -1 through 256^3 to rgb(0,0,0) through rgb(255,255,255)
	var indexToColor = function(i) {
		if (i > 256*256*256) {
			return 'rgb(255,255,255)';
		}
		i++;
		var b = Math.floor(i/256/256);
		var g = Math.floor((i - b*256*256) / 256);
		var r = (i - b*256*256 - g*256);
		return 'rgb('+r+','+g+','+b+')';
	}

	//convert a color to an index value
	//Mapping [0,0,0] through [255,255,255] to -1 through 256^3
	var colorToIndex = function(rgb) {
		return (rgb[0] + rgb[1]*256 + rgb[2]*256*256)-1;
	}

})();'use strict';
(function() {
	/**
	 * CINEMA_COMPONENTS
	 * PCOORDSVG
	 * 
	 * The PcoordSVG Component for the CINEMA_COMPONENTS library.
	 * Contains the constructor for the PcoordSVG component:
	 * A subclass of Pcoord which draws a Paralell Coordinates chart using SVG.
	 * 
	 * @exports CINEMA_COMPONENTS
	 * 
	 * @author Cameron Tauxe
	 */

	//If CINEMA_COMPONENTS is already defined, add to it, otherwise create it
	var CINEMA_COMPONENTS = {}
	if (window.CINEMA_COMPONENTS)
		CINEMA_COMPONENTS = window.CINEMA_COMPONENTS;
	else
		window.CINEMA_COMPONENTS = CINEMA_COMPONENTS;

	//Require that the Pcoord Component be included
	if (!CINEMA_COMPONENTS.PCOORD_INCLUDED)
		throw new Error("CINEMA_COMPONENTS PcoordSVG Component requires that Pcoord"+
			" component be included. Please make sure that Pcoord component"+
			" is included BEFORE PcoordSVG module");

	/** @type {boolean} - Flag to indicate that the PcoordSVG Component has been included */
	CINEMA_COMPONENTS.PCOORDSVG_INCLUDED = true;

	/**
	 * Constructor for PcoordSVG Component
	 * Represents a component for displaying and interacting with a database on a parallel coordinates chart
	 * rendered with SVG
	 * @param {DOM} parent - The DOM object to build this component inside of
	 * @param {CINEMA_COMPONENTS.Database} database - The database behind this component
	 * @param {RegExp} filterRegex - A regex to determine which dimensions to NOT show on the component
	 */
	CINEMA_COMPONENTS.PcoordSVG = function(parent, database, filterRegex) {
		//call super-constructor
		CINEMA_COMPONENTS.Pcoord.call(this,parent,database,filterRegex);

		//Specify that this is a Pcoord SVG component
		d3.select(this.container).classed('SVG',true);

		//Add SVG Components to pathContainer
		this.svg = this.pathContainer.append('svg')
			.style('position','absolute')
			.style('top',this.margin.top+'px')
			.style('left',this.margin.left+'px')
			.attr('width',this.internalWidth+'px')
			.attr('height',this.internalHeight+'px');
		//Add group for selected paths
		this.selectedPaths = this.svg.append('g')
			.classed('selectedPaths',true);
		//Add group for highlighted paths
		this.highlightedPaths = this.svg.append('g')
			.classed('highlightedPaths',true);
		//Add group for overlay paths
		this.overlayPaths = this.svg.append('g')
			.classed('overlayPaths',true);

		this.redrawPaths();
	}
	//establish prototype chain
	CINEMA_COMPONENTS.PcoordSVG.prototype = Object.create(CINEMA_COMPONENTS.Pcoord.prototype);
	CINEMA_COMPONENTS.PcoordSVG.prototype.constructor = CINEMA_COMPONENTS.PcoordSVG;

	/**************************
	 * OVERRIDE METHODS
	 **************************/

	CINEMA_COMPONENTS.PcoordSVG.prototype.updateSize = function() {
		//call super
		CINEMA_COMPONENTS.Pcoord.prototype.updateSize.call(this);

		//rescale svg
		this.svg
			.attr('width',this.internalWidth+'px')
			.attr('height',this.internalHeight+'px');
	}

	/**
	 * Redraw the current selection of paths.
	 */
	CINEMA_COMPONENTS.PcoordSVG.prototype.redrawSelectedPaths = function() {
		var self = this;
		//Bind to selection and update
		var update = this.selectedPaths
			.selectAll('path').data(this.selection);
		update.enter() //ENTER
			.append('path')
		.merge(update) //ENTER + UPDATE
			.attr('index',function(d){return d;})
			.attr('d',function(d){
				return self.getPath(self.db.data[d]);
			})
			.on('mouseenter',function(d){
				self.dispatch.call("mouseover",self,d,d3.event);
			})
			.on('mouseleave',function(d){
				self.dispatch.call("mouseover",self,null,d3.event);
			})
			.on('click', function(d) {
				self.dispatch.call("click",self,d);
			});
		update.exit() //EXIT
			.remove();
	}

	/**
	 * Redraw the currently highlighted path.
	 */
	CINEMA_COMPONENTS.PcoordSVG.prototype.redrawHighlightedPaths = function() {
		var self = this;
		//Bind to highlighted and update
		var update = this.highlightedPaths
			.selectAll('path').data(this.highlighted);
		update.enter() //ENTER
			.append('path')
		.merge(update) //ENTER + UPDATE
			.attr('index',function(d){return d;})
			.attr('d',function(d){
				return self.getPath(self.db.data[d]);
			});
		update.exit() //EXIT
			.remove();
	}

	/**
	 * Redraw the overlay paths.
	 */
	CINEMA_COMPONENTS.PcoordSVG.prototype.redrawOverlayPaths = function() {
		var self = this;
		//Bind to overlayData and update
		var update = this.overlayPaths
			.selectAll('path').data(this.overlayData);
		update.enter() //ENTER
			.append('path')
		.merge(update) //ENTER + UPDATE
			.attr('style',function(d){return d.style;})
			.attr('d',function(d){
				return self.getPath(d.data);
			});
		update.exit() //EXIT
			.remove();
	}

})();'use strict';
(function() {
	/**
	 * CINEMA_COMPONENTS
	 * QUERY
	 * 
	 * The Query Component for the CINEMA_COMPONENTS library.
	 * Contains the constructor for the Query Component
	 * Which allows for defining a custom data point and querying
	 * a database for similar data points
	 * 
	 * @exports CINEMA_COMPONENTS
	 * 
	 * @author Cameron Tauxe
	 */

	//If CINEMA_COMPONENTS is already defined, add to it, otherwise create it
	var CINEMA_COMPONENTS = {}
	if (window.CINEMA_COMPONENTS)
		CINEMA_COMPONENTS = window.CINEMA_COMPONENTS;
	else
		window.CINEMA_COMPONENTS = CINEMA_COMPONENTS;

	//Require that the Component module be included
	if (!CINEMA_COMPONENTS.COMPONENT_INCLUDED)
		throw new Error("CINEMA_COMPONENTS Query module requires that Component"+
			" module be included. Please make sure that Component module"+
			" is included BEFORE Query module");

	//Require that d3 be included
	if (!window.d3) {
		throw new Error("CINEMA_COMPONENTS Query module requires that"+
		" d3 be included (at least d3v4). Please make sure that d3 is included BEFORE the"+
		" the Query module");
	}

	/** @type {boolean} - Flag to indicate that the Query module has been included */
	CINEMA_COMPONENTS.QUERY_INCLUDED = true;

	/**
	 * Constructor for Query Component
	 * Represents a component for querying a database
	 * @param {DOM} parent - The DOM object to build this component inside of 
	 * @param {CINEMA_COMPONENTS.Database} database - The database behind this component
	 * (Note that Query does not use a filterRegex)
	 */
	CINEMA_COMPONENTS.Query = function(parent, database) {
		var self = this;

		/***************************************
		 * SIZING
		 ***************************************/

		//Call super-constructor (will calculate size)
		CINEMA_COMPONENTS.Component.call(this,parent,database);

		/***************************************
		 * DATA
		 ***************************************/

		//override this.dimensions to include only numeric dimensions
		this.dimensions = this.dimensions.filter(function(d) {
			return !self.db.isStringDimension(d);
		});

		/** @type {number[]} Indices of the similar results to the last query */
		this.results = [];

		/** @type {CINEMA_COMPONENTS.ExtraData} The custom-defined data point */
		this.custom = new CINEMA_COMPONENTS.ExtraData({},"");
		/** @type {CINEMA_COMPONENTS.ExtraData} Approximations of the boudnaries for similar data given the threshold */
		this.upper = new CINEMA_COMPONENTS.ExtraData({},"");
		this.lower = new CINEMA_COMPONENTS.ExtraData({},"");
		// (styles will be decided by a client program)

		/***************************************
		 * EVENTS
		 ***************************************/

		/** @type {d3.dispatch} Hook for events on chart
		 * Set handlers with on() function. Ex: this.dispatch.on('query',handlerFunction(results))
		 * 'query': Triggered when a query is made
		 *     (argument is the results of the query (as an array of indices))
		 * 'customchange': Triggered when the custom-defined data point changes
		 *     (arguemnt is an array with extra data custom,upper and lower (in that order))
		*/
		this.dispatch = d3.dispatch('query','customchange');

		/***************************************
		 * SCALES
		 ***************************************/

		//Input sliders for each dimension range from 0 to 100
		//So create scales to scale a slider's value to a value in its dimension
		this.scales = {};
		this.dimensions.forEach(function(d) {
			self.scales[d] = d3.scaleLinear()
				.domain([0,100])
				.range(self.db.dimensionDomains[d]);
		});

		/***************************************
		 * DOM Content
		 ***************************************/

		//Specify that this is a Query component
		d3.select(this.container).classed('QUERY',true);

		/** @type {DOM (button)} Button to perform a query when pressed */
		this.queryButton = d3.select(this.container).append('button')
			.classed('queryButton',true)
			.text("Find Similar")
			.on('click',function() {
				var results = self.db.getSimilar(self.custom.data,self.thresholdNode.value);
				d3.select(self.readout).text(results.length+ " results found!");
				self.dispatch.call('query',self,results.slice());
			})
			.node();

		/** @type {DOM (span)} Label for Threshold input */
		this.thresholdLabel = d3.select(this.container).append('span')
			.classed('thresholdLabel',true)
			.text("Threshold:")
			.node();

		/** @type {DOM (input/number)} Number input for threshold */
		this.thresholdNode = d3.select(this.container).append('input')
			.classed('thresholdInput',true)
			.attr('type','number')
			.attr('max',this.dimensions.length)
			.attr('min',0)
			.attr('step',0.05)
			.on('change',function() {
				self.updateBounds();
				self.dispatch.call('customchange',self,[self.custom,self.upper,self.lower]);
			})
			.node();
		this.thresholdNode.value = 1.0;

		/** @type {DOM (span)} Readout for number of found results */
		this.readout = d3.select(this.container).append('span')
			.classed('readout',true)
			.node();

		/** @type {d3.selection} Input rows for each dimension */
		this.rows = d3.select(this.container).selectAll('.inputRow')
			.data(this.dimensions)
		.enter().append('div')
			.classed('inputRow',true)
			.style('position','relative');
		//Create contents of each input row
		//labels
		this.rows.append('span')
			.classed('label',true)
			.style('position','absolute')
			.text(function(d){return d;});
		//checkbox
		this.rows.append('input')
			.attr('type','checkbox')
			.style('position','absolute')
			.on('input',function(d) {
				if (this.checked) {
					var slider = d3.select(this.parentNode).select('input[type="range"]');
					self.custom.data[d] = self.scales[d](slider.node().value);
				}
				else {
					delete self.custom.data[d];
				}
				self.updateBounds();
				self.dispatch.call('customchange',self,[self.custom,self.upper,self.lower]);
			});
		//slider
		this.rows.append('input')
			.attr('type','range')
			.attr('min',0)
			.attr('max',100)
			.attr('step',1)
			.each(function(){this.value = 50;})
			.style('position','absolute')
			.on('input',function(d){
				var check = d3.select(this.parentNode).select('input[type="checkbox"]');
				if (!check.node().checked)
					check.node().checked = true;
				self.custom.data[d] = self.scales[d](this.value);
				self.updateBounds();
				self.dispatch.call('customchange',self,[self.custom,self.upper,self.lower]);
			});

	}
	//establish prototype chain
	CINEMA_COMPONENTS.Query.prototype = Object.create(CINEMA_COMPONENTS.Component.prototype);
	CINEMA_COMPONENTS.Query.prototype.constructor = CINEMA_COMPONENTS.Query;

	/**
	 * Update upper and lower data depending on custom data and current threshold value
	 */
	CINEMA_COMPONENTS.Query.prototype.updateBounds = function() {
		var self = this;
		var threshold = this.thresholdNode.value;
		//average difference along each dimension
		var avg = (threshold/d3.keys(this.custom.data).length)*100;
		this.upper.data = {};
		this.lower.data = {};
		this.dimensions.forEach(function(d) {
			if (self.custom.data[d] !== undefined) {
				var s = self.scales[d];
				self.lower.data[d] = s(Math.max(s.invert(self.custom.data[d])-avg,0));
				self.upper.data[d] = s(Math.min(s.invert(self.custom.data[d])+avg,100));
			}
		});
	}

})();'use strict';
(function() {
	/**
	 * CINEMA_COMPONENTS
	 * SCATTER_PLOT
	 *
	 * The ScatterPlot component for the CINEMA_COMPONENTS library.
	 * Contains the constructor for ScatterPlot Components (Eg. ScatterPlotSVG, ScatterPlotCanvas)
	 * It is a subclass of Component and contains methods and fields common to all ScatterPlot Components
	 *
	 * @exports CINEMA_COMPONENTS
	 *
	 * @author Cameron Tauxe
	 */

	//If CINEMA_COMPONENTS is already defined, add to it, otherwise create it
	var CINEMA_COMPONENTS = {}
	if (window.CINEMA_COMPONENTS)
		CINEMA_COMPONENTS = window.CINEMA_COMPONENTS;
	else
		window.CINEMA_COMPONENTS = CINEMA_COMPONENTS;

	//Require that the Component module be included
	if (!CINEMA_COMPONENTS.COMPONENT_INCLUDED)
		throw new Error("CINEMA_COMPONENTS ScatterPlot module requires that Component"+
			" module be included. Please make sure that Component module"+
			" is included BEFORE ScatterPlot module");

	//Require that d3 be included
	if (!window.d3) {
		throw new Error("CINEMA_COMPONENTS ScatterPlot module requires that"+
		" d3 be included (at least d3v4). Please make sure that d3 is included BEFORE the"+
		" the ScatterPlot module");
	}

	/** @type {boolean} - Flag to indicate that the ScatterPlot module has been included */
	CINEMA_COMPONENTS.SCATTER_PLOT_INCLUDED = true;

	/**
	 * Abstract constructor for ScatterPlot Components
	 * Represents a component for displaying the data in a database on a 2D scatter plot.
	 * Objects such as ScatterPlotSVG and ScatterPlotCanvas inherit from this.
	 * @param {DOM} parent - The DOM object to build this component inside of
	 * @param {CINEMA_COMPONENTS.Database} database - The database behind this component
	 * @param {RegExp} filterRegex - A regex to determine which dimensions to NOT show on the component
	 */
	CINEMA_COMPONENTS.ScatterPlot = function(parent, database, filterRegex) {
		/*if (this.constructor === CINEMA_COMPONENTS.ScatterPlot)
			throw new Error("Cannot instantiate abstract class 'ScatterPlot'"+
				"Please use a subclass.");*/

		var self = this;

		/***************************************
		 * SIZING
		 ***************************************/

		/** @type {CINEMA_COMPONENTS.Margin} Override default margin */
		this.margin = new CINEMA_COMPONENTS.Margin(25,25,60,150);

		//Call super-constructor
		CINEMA_COMPONENTS.Component.call(this,parent,database,filterRegex);

		/***************************************
		 * DATA
		 ***************************************/

		/** @type {number[]} Indices of all currently displayed data */
		this.selection = [];
		/** @type {number} Indices of all currently highlighted data */
		this.highlighted = [];
		/** @type {CINEMA_COMPONENTS.ExtraData[]} Custom data to overlay on chart */
		this.overlayData = [];

		/** @type {string} The currently selected dimensions for each axis*/
		this.xDimension = this.dimensions[0];
		this.yDimension = this.dimensions[1];

		/***************************************
		 * EVENTS
		 ***************************************/

		/** @type {d3.dispatch} Hook for events on chart
		 * Set handlers with on() function. Ex: this.dispatch.on('mouseover',handlerFunction(i))
		 * 'mouseover': Triggered when a point is moused over.
		 *     (called with the index of moused over data and a reference to the mouse event)
		 * 'xchanged': Triggered when the x dimension being viewed is changed
		 *     (called with the new dimension as an argument)
		 * 'ychanged': Triggered when the y dimension being viewed is changed
		 *     (called with the new dimension as an argument)
		*/
		this.dispatch = d3.dispatch("mouseover",'xchanged','ychanged');

		/***************************************
		 * SCALES
		 ***************************************/

		/** @type {d3.scale} The scales for the x and y axes */
		this.x = (this.db.isStringDimension(this.xDimension) ? d3.scalePoint() : d3.scaleLinear())
			.domain(this.db.dimensionDomains[this.xDimension])
			.range([15,this.internalWidth-15]);
		this.y = (this.db.isStringDimension(this.yDimension) ? d3.scalePoint() : d3.scaleLinear())
		.domain(this.db.dimensionDomains[this.yDimension])
		.range([this.internalHeight-15,15]);

		/***************************************
		 * DOM Content
		 ***************************************/

		//Specify that this a ScatterPlot component
		d3.select(this.container).classed('SCATTER_PLOT',true);

		/** @type {d3.selection} Where the data on the chart will be drawn
		 * The actual drawing depends on the specific ScatterPlot sublcass
		 */
		this.pointContainer = d3.select(this.container).append('div')
			.classed('pointContainer',true)
			.style('position','absolute')
			.style('top',this.margin.top+'px')
			.style('right',this.margin.right+'px')
			.style('bottom',this.margin.bottom+'px')
			.style('left',this.margin.left+'px')
			.style('width',this.internalWidth+'px')
			.style('height',this.internalHeight+'px');

		/** @type {DOM (select)} The select elements for selecting the dimension for each axis */
		//x
		this.xSelect = d3.select(this.container).append('select')
			.classed('dimensionSelect x',true)
			.style('position','absolute')
			.node();
		//y
		this.ySelect = d3.select(this.container).append('select')
			.classed('dimensionSelect y',true)
			.style('position','absolute')
			.node();
		//Bind data and append options
		//x
		d3.select(this.xSelect).selectAll('option')
			.data(this.dimensions)
			.enter().append('option')
				.attr('value',function(d){return d;})
				.text(function(d){return d;});
		d3.select(this.xSelect).node().value = this.xDimension;
		//y
		d3.select(this.ySelect).selectAll('option')
			.data(this.dimensions)
			.enter().append('option')
				.attr('value',function(d){return d;})
				.text(function(d){return d;});
		d3.select(this.ySelect).node().value = this.yDimension;
		//Add change listeners to select elements
		//x
		d3.select(this.xSelect).on('input',function() {
			self.xDimension = this.value;
			self.x = (self.db.isStringDimension(self.xDimension) ? d3.scalePoint() : d3.scaleLinear())
				.domain(self.db.dimensionDomains[self.xDimension])
				.range([0,self.internalWidth]);
			self.xAxisContainer.select('.axis')
				.call(d3.axisBottom().scale(self.x));
			self.dispatch.call('xchanged',self,self.xDimension);
			self.redrawPoints();
		});
		//y
		d3.select(this.ySelect).on('input',function() {
			self.yDimension = this.value;
			self.y = (self.db.isStringDimension(self.yDimension) ? d3.scalePoint() : d3.scaleLinear())
				.domain(self.db.dimensionDomains[self.yDimension])
				.range([self.internalHeight,0]);
			self.yAxisContainer.select('.axis')
				.call(d3.axisLeft().scale(self.y));
				self.dispatch.call('ychanged',self,self.yDimension);
			self.redrawPoints();
		});

		/** @type {d3.selection} A readout in the corner of the chart
		 * that warns if any data could not be plotted
		 */
		this.warningReadout = d3.select(this.container).append('div')
			.classed('warningReadout',true)
			.style('position','absolute');

		/***************************************
		 * AXES
		 ***************************************/

		/** @type {d3.selection} The container for each axis */
		//x
		this.xAxisContainer = d3.select(this.container).append('svg')
			.classed('axisContainer x',true)
			.style('position','absolute')
			.style('width',this.internalWidth+'px')
			.style('height',25+'px')
			.style('top',this.margin.top+this.internalHeight+'px')
			.style('left',this.margin.left+'px');
		//y
		this.yAxisContainer = d3.select(this.container).append('svg')
			.classed('axisContainer y',true)
			.style('position','absolute')
			.style('width',50+'px')
			.style('height',this.internalHeight+'px')
			.style('left',(this.margin.left-50)+'px')
			.style('top',this.margin.top+'px');
		//Add axis to each axis container
		//x
		this.xAxisContainer.append('g')
			.classed('axis',true)
			.call(d3.axisBottom().scale(this.x));
		//y
		this.yAxisContainer.append('g')
			.classed('axis',true)
			.attr('transform','translate(50)')
			.call(d3.axisLeft().scale(this.y));

	};
	//establish prototype chain
	CINEMA_COMPONENTS.ScatterPlot.prototype = Object.create(CINEMA_COMPONENTS.Component.prototype);
	CINEMA_COMPONENTS.ScatterPlot.prototype.constructor = CINEMA_COMPONENTS.ScatterPlot;

	/**
	 * Should be called every time the size of the chart's container changes.
	 * Updates the sizing and scaling of all parts of the chart and redraws
	 */
	CINEMA_COMPONENTS.ScatterPlot.prototype.updateSize = function() {
		//Call super (will recalculate size)
		CINEMA_COMPONENTS.Component.prototype.updateSize.call(this);

		//update pointContainer size
		this.pointContainer
			.style('width',this.internalWidth+'px')
			.style('height',this.internalHeight+'px');

		//Rescale
		this.x.range([15,this.internalWidth-15]);
		this.y.range([this.internalHeight-15,15]);

		//Reposition and rescale axes
		this.xAxisContainer
			.style('top',this.margin.top+this.internalHeight+'px')
			.style('width',this.internalWidth+'px')
			.select('.axis')
				.call(d3.axisBottom().scale(this.x));
		this.yAxisContainer
			.style('height',this.internalHeight+'px')
			.select('.axis')
				.call(d3.axisLeft().scale(this.y));

		this.redrawPoints();
	}

	//Shortcut function for redrawSelectedPoints, redrawHighlightedPoints and redrawOverlayPoints
	CINEMA_COMPONENTS.ScatterPlot.prototype.redrawPoints = function() {
		this.redrawSelectedPoints();
		this.redrawHighlightedPoints();
		this.redrawOverlayPoints();
	}

	/**
	 * Filter the given selection into only the points that can be shown
	 * on the plot (i.e. do not have NaN or undefined values on current dimensions)
	 */
	CINEMA_COMPONENTS.ScatterPlot.prototype.getPlottablePoints = function(selection) {
		var self = this;
		return selection.filter(function(d) {
			var xCoord = self.x(self.db.data[d][self.xDimension]);
			var yCoord = self.y(self.db.data[d][self.yDimension]);
			return !(isNaN(xCoord) || isNaN(yCoord));
		});
	}

	/**
	 * Set the chart's selection of data to the data represented
	 * by the given list of indices
	 */
	CINEMA_COMPONENTS.ScatterPlot.prototype.setSelection = function(selection) {
		this.selection = selection;
		this.redrawSelectedPoints();
	}

	/**
	 * Set the chart's current highlighted data to the data represented
	 * by the given list of indices
	 */
	CINEMA_COMPONENTS.ScatterPlot.prototype.setHighlightedPoints = function(indices) {
		this.highlighted = indices;
		this.redrawHighlightedPoints();
	}

	/**
	 * Set the current overlay points
	 */
	CINEMA_COMPONENTS.ScatterPlot.prototype.setOverlayPoints = function(data) {
		this.overlayData = data;
		this.redrawOverlayPaths();
	};

	/**
	 * Redraw the current selection of points.
	 * Actual implementation is up to specific subclasses
	 */
	CINEMA_COMPONENTS.ScatterPlot.prototype.redrawSelectedPoints = function() {
		throw new Error("Cannot call abstract function 'redrawSelectedPoints()'!"+
			" Please override function in a subclass");
	}

	/**
	 * Redraw the currently highlighted points.
	 * Actual implementation is up to specific subclasses
	 */
	CINEMA_COMPONENTS.ScatterPlot.prototype.redrawHighlightedPoints = function() {
		throw new Error("Cannot call abstract function 'redrawHighlightedPoints()'!"+
			" Please override function in a subclass");
	}

	/**
	 * Redraw the overlay points.
	 * Actual implementation is up to specific subclasses
	 */
	CINEMA_COMPONENTS.ScatterPlot.prototype.redrawOverlayPoints = function() {
		throw new Error("Cannot call abstract function 'redrawOverlayPoints()'!"+
			" Please override function in a subclass");
	}
})();
'use strict';
(function() {
	/**
	 * CINEMA_COMPONENTS
	 * SCATTER_PLOT_CANVAS
	 * 
	 * The ScatterPlotCanvas Component for the CINEMA_COMPONENTS library.
	 * Contains the constructor for the ScatterplotCanvas Component:
	 * A subclass of ScatterPlot which draws data using canvas elements
	 * 
	 * @exports CINEMA_COMPONENTS
	 * 
	 * @author Cameron Tauxe
	 */

	//If CINEMA_COMPONENTS is already defined, add to it, otherwise create it
	var CINEMA_COMPONENTS = {}
	if (window.CINEMA_COMPONENTS)
		CINEMA_COMPONENTS = window.CINEMA_COMPONENTS;
	else
		window.CINEMA_COMPONENTS = CINEMA_COMPONENTS;

	//Require that the ScatterPlot Component be included
	if (!CINEMA_COMPONENTS.SCATTER_PLOT_INCLUDED)
		throw new Error("CINEMA_COMPONENTS ScatterPlotCanvas Component requires that ScatterPlot"+
			" component be included. Please make sure that ScatterPlot component"+
			" is included BEFORE ScatterPlotCanvas module");

	/** @type {boolean} - Flag to indicate that the ScatterPlotSVG Component has been included */
	CINEMA_COMPONENTS.SCATTER_PLOT_CANVAS_INCLUDED = true;

	/**
	 * Constructor for ScatterPlotCanvas Component
	 * Represents a component for displaying data on a 2D Scatter Plot
	 * Rendered with canvas elements
	 * @param {DOM} parent - The DOM object to build this component inside of
	 * @param {CINEMA_COMPONENTS.Database} database - The database behind this component
	 * @param {RegExp} filterRegex - A regex to determine which dimensions to NOT show on the component
	 */
	CINEMA_COMPONENTS.ScatterPlotCanvas = function(parent, database, filterRegex) {
		var self = this;

		//call super-constructor
		CINEMA_COMPONENTS.ScatterPlot.call(this,parent,database,filterRegex);

		//specify that this is a ScatterPlot Canvas component.
		d3.select(this.container).classed('CANVAS',true);

		//Because not every point in the selection will be on the plot,
		//need to keep track of plottablePoints so that their
		//index can be used on indexCanvas
		this.plottablePoints = [];

		//Add canvases to pathContainer
		this.selectedCanvas = this.pointContainer.append('canvas')
			.classed('selectedCanvas',true)
			.node();
		this.highlightedCanvas = this.pointContainer.append('canvas')
			.classed('highlightedCanvas',true)
			.node();
		this.overlayCanvas = this.pointContainer.append('canvas')
			.classed('overlayCanvas',true)
			.node();
		//Index canvas is invisible and draws in a unique color for each path
		//Its color data is used to determine which path is being moused over
		this.indexCanvas = this.pointContainer.append('canvas')
			.classed('indexCanvas',true)
			.style('display','none')
			.node();
		//Size/position canvases
		this.pointContainer.selectAll('canvas')
			.style('position','absolute');

		//Determine screen DPI to rescale canvas contexts
		//(prevents artifacts and blurring on some displays)
		//https://stackoverflow.com/a/15666143/2827258
		this.pixelRatio = (function() {
			var ctx = document.createElement('canvas').getContext("2d"),
				dpr = window.devicePixelRatio || 1,
				bsr = ctx.webkitBackingStorePixelRatio ||
						ctx.mozBackingStorePixelRatio ||
						ctx.msBackingStorePixelRatio ||
						ctx.oBackingStorePixelRatio ||
						ctx.backingStorePixelRatio || 1;
				return dpr / bsr;
		})();

		//Loading/still drawing indicator
		this.loading = d3.select(this.container).append('div')
			.classed('loadingIndicator',true)
			.style('display','none')
			.text('Drawing...');

		//Set an interval to call drawIterator if it exists
		//roughly 60 times a second
		this.interval = setInterval(function(self) {
			for (var i = 0; i < 25; i++) {
				if (self.drawIterator) {
					if (self.drawIterator.next().done) {
						self.drawIterator = undefined;
						self.loading.style('display','none');
					}
				}
			}
		}, 16, this);

		//Set up mousemove listener to get moused-over paths
		this.lastMouseMove = null; //remember last result, to prevent excessive dispatch calls
		this.pointContainer.on('mousemove', function() {
			var x = d3.mouse(self.selectedCanvas)[0]*self.pixelRatio;
			var y = d3.mouse(self.selectedCanvas)[1]*self.pixelRatio;
			if (x >= 0 && y >= 0) {
				var index = getIndexAtPoint(x,y,self.indexCanvas);
				if (index != -1) {
					if (self.lastMouseMove != self.plottablePoints[index]) {
						self.lastMouseMove = self.plottablePoints[index];
						self.dispatch.call('mouseover',self,self.plottablePoints[index],d3.event);
					}
				}
				else {
					if (self.lastMouseMove !== null) {
						self.lastMouseMove = null;
						self.dispatch.call('mouseover',self,null,d3.event);
					}
				}
			}
		});

		this.updateSize();
	}
	//establish prototype chain
	CINEMA_COMPONENTS.ScatterPlotCanvas.prototype = Object.create(CINEMA_COMPONENTS.ScatterPlot.prototype);
	CINEMA_COMPONENTS.ScatterPlotCanvas.prototype.constructor = CINEMA_COMPONENTS.ScatterPlotCanvas;

	/**************************
	 * OVERRIDE METHODS
	 **************************/

	CINEMA_COMPONENTS.ScatterPlotCanvas.prototype.updateSize = function() {
		var self = this;
		//call super
		CINEMA_COMPONENTS.ScatterPlot.prototype.updateSize.call(this);

		//Resize canvases
		this.pointContainer.selectAll('canvas')
			.style('width',this.internalWidth+'px')
			.style('height',this.internalHeight+'px')
		// width/height styles are distinct from attributes
		// (attributes determine context size, style is the size the canvas appears in on screen)
			.attr('width',this.internalWidth*this.pixelRatio+'px')
			.attr('height',this.internalHeight*this.pixelRatio+'px')
			.each(function(){
				this.getContext('2d').scale(self.pixelRatio,self.pixelRatio);
			});
		//Init canvas contexts
		var selectedContext = this.selectedCanvas.getContext('2d');
		selectedContext.fillStyle = 'rgba(82, 137, 163, 0.521)';
		selectedContext.strokeStyle = 'rgb(69, 121, 153)';
		selectedContext.lineWidth = 2;
		var highlightedContext = this.highlightedCanvas.getContext('2d');
		highlightedContext.fillStyle = 'rgb(252, 127, 127)';
		highlightedContext.strokeStyle = 'rgb(153, 80, 80)';
		highlightedContext.lineWidth = 3;

		this.redrawPoints();
	}

	/**
	 * Redraw the current selection of points
	 */
	CINEMA_COMPONENTS.ScatterPlotCanvas.prototype.redrawSelectedPoints = function() {
		var self = this;

		this.plottablePoints = this.getPlottablePoints(this.selection);
		//Update warningReadout
		if (this.plottablePoints.length < this.selection.length)
			this.warningReadout.text((this.selection.length-this.plottablePoints.length) + 
				" point(s) could not be plotted (because they contain NaN or undefined values).");
		else
			this.warningReadout.text('');

		var ctx = this.selectedCanvas.getContext('2d');
		ctx.clearRect(0,0,this.internalWidth,this.internalHeight);

		var indexCtx = this.indexCanvas.getContext('2d');
		indexCtx.clearRect(0,0,this.internalWidth,this.internalHeight);

		this.drawIterator = (function*(queue){
			self.loading.style('display','initial');
			var i = 0;
			while (i < queue.length) {
				var x = self.x(self.db.data[queue[i]][self.xDimension]);
				var y = self.y(self.db.data[queue[i]][self.yDimension]);
				ctx.beginPath();
				ctx.arc(x,y,6,0,2*Math.PI);
				ctx.fill();
				ctx.stroke();

				indexCtx.fillStyle = indexToColor(i);
				indexCtx.beginPath();
				indexCtx.arc(x,y,10,0,2*Math.PI);
				indexCtx.fill();

				yield ++i;
			}
		})(this.plottablePoints);
	}

	/**
	 * Redraw the current selection of points
	 */
	CINEMA_COMPONENTS.ScatterPlotCanvas.prototype.redrawHighlightedPoints = function() {
		var self = this;

		var plottable = this.getPlottablePoints(this.highlighted);

		var ctx = this.highlightedCanvas.getContext('2d');
		ctx.clearRect(0,0,this.internalWidth,this.internalHeight);

		plottable.forEach(function(d) {
			var x = self.x(self.db.data[d][self.xDimension]);
			var y = self.y(self.db.data[d][self.yDimension]);
			ctx.beginPath();
			ctx.arc(x,y,10,0,2*Math.PI);
			ctx.fill();
			ctx.stroke();
		});
	}

	/**
	 * Redraw the overlay points
	 */
	CINEMA_COMPONENTS.ScatterPlotCanvas.prototype.redrawOverlayPoints = function() {
		var self = this;

		var ctx = this.overlayCanvas.getContext('2d');
		ctx.clearRect(0,0,this.internalWidth,this.internalHeight);

		this.overlayData.forEach(function(d) {
			//Parse style
			ctx.lineWidth = d.style.lineWidth || 0;
			ctx.lineCap = d.style.lineCap || 'butt';
			ctx.lineJoin = d.style.lineJoin || 'miter';
			ctx.miterLimit = d.style.miterLimit || 10;
			ctx.strokeStyle = d.style.strokeStyle || 'black';
			ctx.fillStyle = d.style.fillStyle || 'black';
			if (d.style.lineDash)
				ctx.setLineDash(d.style.lineDash);
			else
				ctx.setLineDash([]);
			//Draw line
			var x = self.x(d.data[self.xDimension]);
			var y = self.y(d.data[self.yDimension]);
			ctx.beginPath();
			ctx.arc(x,y,(d.style.r || 6),0,2*Math.PI);
			ctx.fill();
			ctx.stroke();
		});

	}

	//Get the index of the path at the given point
	//using the colors on the index canvas
	//returns -1 if there is no path, or the area around the point is too noisy
	var getIndexAtPoint = function(x,y,canvas) {
		//get the color data for a 3x3 pixel area around the point
		var colorData = canvas.getContext('2d').getImageData(x-1,y-1,3,3).data;
		//get the index for each pixel
		var indices = [];
		for (var i = 0; i < colorData.length/4; i++) {
			indices.push(colorToIndex(colorData.slice(i*4,i*4+3)));
		}

		//for a positive match, must find at least 5 pixels with the same index
		indices.sort();
		var matched = -1;
		var count = 0;
		var counting = -1;
		for (var i = 0; i < indices.length; i++) {
			if (counting != indices[i]) {
				count = 1;
				counting = indices[i];
			}
			else {
				count++;
				if (count == 5) {
					matched = counting;
					break;
				}
			}
		}

		return matched;
	}

	//convert an index value to a color
	//Mapping -1 through 256^3 to rgb(0,0,0) through rgb(255,255,255)
	var indexToColor = function(i) {
		if (i > 256*256*256) {
			return 'rgb(255,255,255)';
		}
		i++;
		var b = Math.floor(i/256/256);
		var g = Math.floor((i - b*256*256) / 256);
		var r = (i - b*256*256 - g*256);
		return 'rgb('+r+','+g+','+b+')';
	}

	//convert a color to an index value
	//Mapping [0,0,0] through [255,255,255] to -1 through 256^3
	var colorToIndex = function(rgb) {
		return (rgb[0] + rgb[1]*256 + rgb[2]*256*256)-1;
	}

})();'use strict';
(function() {
	/**
	 * CINEMA_COMPONENTS
	 * SCATTER_PLOT_SVG
	 * 
	 * The ScatterPlotSVG Component for the CINEMA_COMPONENTS library.
	 * Contains the constructor for the ScatterplotSVG Component:
	 * A subclass of ScatterPlot which draws data using SVG
	 * 
	 * @exports CINEMA_COMPONENTS
	 * 
	 * @author Cameron Tauxe
	 */

	//If CINEMA_COMPONENTS is already defined, add to it, otherwise create it
	var CINEMA_COMPONENTS = {}
	if (window.CINEMA_COMPONENTS)
		CINEMA_COMPONENTS = window.CINEMA_COMPONENTS;
	else
		window.CINEMA_COMPONENTS = CINEMA_COMPONENTS;

	//Require that the ScatterPlot Component be included
	if (!CINEMA_COMPONENTS.SCATTER_PLOT_INCLUDED)
		throw new Error("CINEMA_COMPONENTS ScatterPlotSVG Component requires that ScatterPlot"+
			" component be included. Please make sure that ScatterPlot component"+
			" is included BEFORE ScatterPlotSVG module");

	/** @type {boolean} - Flag to indicate that the ScatterPlotSVG Component has been included */
	CINEMA_COMPONENTS.SCATTER_PLOT_SVG_INCLUDED = true;

	/**
	 * Constructor for ScatterPlotSVG Component
	 * Represents a component for displaying data on a 2D Scatter Plot
	 * Rendered with SVG
	 * @param {DOM} parent - The DOM object to build this component inside of
	 * @param {CINEMA_COMPONENTS.Database} database - The database behind this component
	 * @param {RegExp} filterRegex - A regex to determine which dimensions to NOT show on the component
	 */
	CINEMA_COMPONENTS.ScatterPlotSVG = function(parent, database, filterRegex) {
		//call super-constructor
		CINEMA_COMPONENTS.ScatterPlot.call(this,parent,database,filterRegex);

		//specify that this is a ScatterPlot SVG component.
		d3.select(this.container).classed('SVG',true);

		//Add SVG Components to pointContainer
		this.svg = this.pointContainer.append('svg')
			.style('position','absolute')
			.attr('viewBox','0 0 '+this.internalWidth+' '+this.internalHeight)
			.attr('preserveAspectRatio','none')
			.attr('width','100%')
			.attr('height','100%');
		//Add group for selected points
		this.selectedPoints = this.svg.append('g')
			.classed('selectedPoints',true);
		//Add group for highlighted points
		this.highlightedPoints = this.svg.append('g')
			.classed('highlightedPoints',true);
		//Add group for overlay points
		this.overlayPoints = this.svg.append('g')
			.classed('overlayPoints',true);

		this.redrawPoints();
	}
	//establish prototype chain
	CINEMA_COMPONENTS.ScatterPlotSVG.prototype = Object.create(CINEMA_COMPONENTS.ScatterPlot.prototype);
	CINEMA_COMPONENTS.ScatterPlotSVG.prototype.constructor = CINEMA_COMPONENTS.ScatterPlotSVG;

	/**************************
	 * OVERRIDE METHODS
	 **************************/

	CINEMA_COMPONENTS.ScatterPlotSVG.prototype.updateSize = function() {
		//call super
		CINEMA_COMPONENTS.ScatterPlot.prototype.updateSize.call(this);

		//rescale svg
		this.svg.attr('viewBox','0 0 '+this.internalWidth+' '+this.internalHeight);
	}

	/**
	 * Redraw the current selection of points
	 */
	CINEMA_COMPONENTS.ScatterPlotSVG.prototype.redrawSelectedPoints = function() {
		var self = this;
		var plottable = this.getPlottablePoints(this.selection);
		//Update warningReadout
		if (plottable.length < this.selection.length)
			this.warningReadout.text((this.selection.length-plottable.length) + 
				" point(s) could not be plotted (because they contain NaN or undefined values).");
		else
			this.warningReadout.text('');
		//Bind to selection and update
		var update = this.selectedPoints
			.selectAll('circle').data(plottable);
		update.enter() //ENTER
			.append('circle')
			.attr('r','6')
		.merge(update) //ENTER + UPDATE
			.attr('index',function(d){return d;})
			.attr('cx',function(d) {
				return self.x(self.db.data[d][self.xDimension]);
			})
			.attr('cy',function(d) {
				return self.y(self.db.data[d][self.yDimension]);
			})
			.on('mouseenter',function(d) {
				self.dispatch.call('mouseover',self,d,d3.event);
			})
			.on('mouseleave',function(d) {
				self.dispatch.call('mouseover',self,null,d3.event);
			});
		update.exit()
			.remove();
	}

	/**
	 * Redraw the set of highlighted points
	 */
	CINEMA_COMPONENTS.ScatterPlotSVG.prototype.redrawHighlightedPoints = function() {
		var self = this;
		//Bind to selection and update
		var update = this.highlightedPoints
			.selectAll('circle').data(this.getPlottablePoints(this.highlighted));
		update.enter() //ENTER
			.append('circle')
			.attr('r','10')
		.merge(update) //ENTER + UPDATE
			.attr('index',function(d){return d;})
			.attr('cx',function(d) {
				return self.x(self.db.data[d][self.xDimension]);
			})
			.attr('cy',function(d) {
				return self.y(self.db.data[d][self.yDimension]);
			});
		update.exit()
			.remove();
	}

	/**
	 * Redraw the overlay points
	 */
	CINEMA_COMPONENTS.ScatterPlotSVG.prototype.redrawOverlayPoints = function() {
		var self = this;
		//Bind to selection and update
		var update = this.overlayPoints
			.selectAll('circle').data(this.overlayData);
		update.enter() //ENTER
			.append('circle')
			.attr('r','5')
		.merge(update) //ENTER + UPDATE
			.attr('cx',function(d) {
				return self.x(d.data[self.xDimension]);
			})
			.attr('cy',function(d) {
				return self.y(d.data[self.yDimension]);
			})
			.attr('style',function(d) {
				return d.style;
			});
		update.exit()
			.remove();
	}

})();