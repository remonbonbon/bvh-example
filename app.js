(function() {
	'use strict';

	// Original feature layer
	var originalLayer = new ol.layer.Vector({
		source: new ol.source.Vector(),
		style: new ol.style.Style({
			fill: new ol.style.Fill({color: '#eee'}),
			stroke: new ol.style.Stroke({color: '#888', width: 0.5}),
		}),
	});

	// BVH bounding-box layer
	var bvhCache = {};
	var parentIdColor = {};
	var bvhLayer = new ol.layer.Vector({
		source: new ol.source.Vector(),
		style: function(feature) {
			var prop = feature.getProperties();
			var depth = prop.depth;
			var visibleDepth = parseInt(document.getElementById('depth').value, 10);
			if (depth !== visibleDepth) return;

			var key = prop.nodeId;
			if (bvhCache[key]) return bvhCache[key];

			// Colors by parentId
			var color = parentIdColor[prop.parentId];
			if (!color) {
				parentIdColor[prop.parentId]
					= color
					= [
						100 + Math.random() * 155,
						100 + Math.random() * 155,
						100 + Math.random() * 155,
						0.5
					];
			}

			return bvhCache[key] = new ol.style.Style({
				fill: new ol.style.Fill({color: color}),
				stroke: new ol.style.Stroke({
					color: [color[0] * 0.8, color[1] * 0.8, color[2] * 0.8, 0.7],
					width: 1
				}),
			});
		},
	});

	// The map
	var map = new ol.Map({
		target: 'map',
		layers: [
			originalLayer,
			bvhLayer,
		],
		view: new ol.View()
	});

	// Add GeoJSON features to layer.
	// This method is used for conversion from "turf.feature" to "ol.Feature"
	function addGeoJsonFeatures(layer, features) {
		layer.getSource().addFeatures(
			(new ol.format.GeoJSON()).readFeatures(
				turf.featurecollection(features), {
					dataProjection: 'EPSG:4326',
					featureProjection: 'EPSG:3857'
				}
			)
		);
	}

	// Returns the order of node
	function orderNode(node) {
		var c = turf.centroid(turf.bboxPolygon(node.extent));
		return [
			Math.round(c.geometry.coordinates[1] * 1000),
			Math.round(c.geometry.coordinates[0] * 1000),
		].join('_');
	}

	// Split nodes to some group.
	// This method is kernel of constructBvh()
	function splitNodes(node, depth) {
		var groups = [];
		var distanceThreshold = Math.sqrt(turf.area(turf.bboxPolygon(node.extent))) * 0.5;	// meters

		node.nodes
		.sort(function(n1, n2) {
			var order1 = orderNode(n1);
			var order2 = orderNode(n2);
			if (order1 < order2) return -1;
			if (order1 > order2) return 1;
			return 0;
		})
		.forEach(function(n, index) {
			// Find nearest group or create new group
			var minDistance = Infinity;
			var minIndex = -1;
			var extentCenter = turf.centroid(turf.bboxPolygon(n.extent));
			groups.forEach(function(nodes, index) {
				var ex = nodes[0].extent;	// Select the first node as a typical node.
				var p = turf.centroid(turf.bboxPolygon(ex));
				var distance = turf.distance(p, extentCenter) * 1000;	// km => meters
				if (distance < minDistance) {
					minDistance = distance;
					minIndex = index;
				}
			});
			if (minIndex < 0 || distanceThreshold < minDistance) {
				// Create new group
				groups.push([n]);
			} else {
				// Push to nearest group
				groups[minIndex].push(n);
			}
		});
		// Make least 2 groups
		if (groups.filter(function(g) {return 0 < g.length}).length < 2) {
			// Divided into groups of two halves.
			var capacityOfGroup = Math.round(node.nodes.length / 2) || 1;
			return node.nodes.reduce(function(result, n, index) {
				var gi = Math.floor(index / capacityOfGroup);
				while(result.length <= gi) result.push([]);
				result[gi].push(n);
				return result;
			}, []);
		}
		return groups;
	}

	// Check if node be able to split.
	function canSplit(node) {
		var area = turf.area(turf.bboxPolygon(node.extent));
		var minArea = Math.pow(2500, 2);	// meters^2
		return minArea < area;
	}

	// Construct the Bounding Volume Hierarchy.
	function constructBvh(node, depth) {
		depth = depth || 1;

		if (node.nodes.length <= 1) return node;	// End node

		// Split the node to some nodes
		node.nodes = splitNodes(node, depth).map(function(nodes) {
			return {
				extent: turf.extent(turf.featurecollection(
					nodes.map(function(n) {return turf.bboxPolygon(n.extent)})
				)),
				nodes: nodes,
			};
		});

		// Split the sub-nodes recursively until canSplit() returns false
		node.nodes = node.nodes.map(function(n) {
			if (canSplit(n)) {
				return constructBvh(n, depth + 1);
			} else {
				return n;
			}
		});
		return node;
	}

	fetch('around-tsukuba-city.topojson')
	.then(function(res) {return res.json();})
	.then(function(topojson) {
		// Create original features
		var originalFeatures = (new ol.format.TopoJSON()).readFeatures(topojson);
		originalLayer.getSource().addFeatures(originalFeatures.map(function(f) {
			var f2 = f.clone();
			f2.getGeometry().transform('EPSG:4326', 'EPSG:3857');
			return f2;
		}));

		// Create bounding-box features
		var bboxes = originalFeatures.map(function(f) {
			return turf.bboxPolygon(f.getGeometry().getExtent());
		});

		// Create BVH
		var bvh = constructBvh({
			extent: turf.extent(turf.featurecollection(bboxes)),
			nodes: bboxes.map(function(f) {
				f.extent = turf.extent(f);
				return f;
			}),
			nodeId: 1,
			parentId: 0,
		});

		// Add BVH nodes to layer
		var nodes = [bvh];
		var bvhFeatures = [];
		var depth = 0;
		var newNodeId = bvh.nodeId;
		while(true) {
			depth += 1;
			// console.log('Depth: %d, Number of nodes: %d', depth, nodes.length);
			nodes = nodes.reduce(function(result, n) {
				var feature = turf.bboxPolygon(n.extent);
				feature.properties = {
					depth: depth,
					nodeId: n.nodeId,
					parentId: n.parentId,
				};
				bvhFeatures.push(feature);
				if (!n.nodes) return result;	// end-nodes
				return result.concat(n.nodes.map(function(m) {
					newNodeId += 1;
					m.nodeId = newNodeId;
					m.parentId = n.nodeId;
					return m;
				}));
			}, []);
			if (nodes.length === 0) break;
		}
		console.log('Max depth:', depth);
		addGeoJsonFeatures(bvhLayer, bvhFeatures);

		// Set max depth
		document.getElementById('depth').setAttribute('max', depth);

		// Fit zoom
		map.getView().fit(bvhLayer.getSource().getExtent(), map.getSize());
	});

	// On depth change, redraw layer.
	document.getElementById('depth').addEventListener('change', function(e) {
		bvhLayer.changed();
	});

	// Fit zoom button
	document.getElementById('zoom').addEventListener('click', function(e) {
		map.getView().fit(bvhLayer.getSource().getExtent(), map.getSize());
	});
})();
