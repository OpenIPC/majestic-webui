const IMG_WIDTH = Math.round(parent.document.getElementById('_row').offsetWidth * 0.99);
const MOTION_SIZE = _motion_size();
const COEFF = MOTION_SIZE[0] / IMG_WIDTH;
const GRN = 'rgba(0,255,0,0.5)';
const RED = 'rgba(255,0,0,0.5)';

function _motion_size() {
	const xhr = new XMLHttpRequest();
	xhr.open("GET", "/api/v1/config.json", false); // synchronous
	xhr.send(null);
	return JSON.parse(xhr.responseText).video0.size.split('x');
}

function set_canvas_size() {
	document.getElementById('canvas').style.width = IMG_WIDTH + 'px';
	document.getElementById('canvas').style.height = Math.round((MOTION_SIZE[1] / COEFF)) + 'px';
	parent.document.getElementById('_iframe').style.width = IMG_WIDTH + 2 + 'px';
	parent.document.getElementById('_iframe').style.height = Math.round((MOTION_SIZE[1] / COEFF)) + 2 + 'px';
}

function initDraw(canvas) {
	set_canvas_size();
	function setMousePosition(e) {
		let ev = e || window.event; //Moz || IE
		if (ev.pageX) { //Moz
			mouse.x = ev.pageX + window.pageXOffset;
			mouse.y = ev.pageY + window.pageYOffset;
		} else if (ev.clientX) { //IE
			mouse.x = ev.clientX + document.body.scrollLeft;
			mouse.y = ev.clientY + document.body.scrollTop;
		}
	};

	let mouse = {
		x: 0,
		y: 0,
		startX: 0,
		startY: 0
	};
	let element = null;

	function draw_rectangle(s, color) {
		e= document.createElement('div');
		e.className = 'rectangle'
		e.style.left =	(s[0] / COEFF) + 'px'; e.style.top =	(s[1] / COEFF) + 'px';
		e.style.width =	(s[2] / COEFF) + 'px'; e.style.height =	(s[3] / COEFF) + 'px';
		e.style.background = color; 
		canvas.appendChild(e)
		e = null;
	}
	// draw current regions
	for ( v of (parent.document.getElementById('_motionDetect_roi').value).split(', ') )	{
		draw_rectangle (v.split('x'), GRN);
	}
	for ( v of (parent.document.getElementById('_motionDetect_skipIn').value).split(', ') )	{
		draw_rectangle (v.split('x'), RED);
	}

	canvas.onmousemove = function (e) {
		setMousePosition(e);
		if (element !== null) {
			v_width = Math.abs(mouse.x - mouse.startX);
			v_height = Math.abs(mouse.y - mouse.startY);
			element.style.width = v_width + 'px';
			element.style.height = v_height + 'px';
			element.style.left = (mouse.x - mouse.startX < 0) ? mouse.x + 'px' : mouse.startX + 'px';
			element.style.top = (mouse.y - mouse.startY < 0) ? mouse.y + 'px' : mouse.startY + 'px';
		}
	}

	canvas.onclick = function (e) {
		if (element == null) {	// start

			mouse.startX = mouse.x;
			mouse.startY = mouse.y;
			element = document.createElement('div');
			element.className = 'rectangle'
			element.style.left = mouse.x + 'px';
			element.style.top = mouse.y + 'px';
			element.style.left = (mouse.x - mouse.startX < 0) ? mouse.x + 'px' : mouse.startX + 'px';
			canvas.appendChild(element)
			canvas.style.cursor = "crosshair";
			if (parent.document.getElementById('_fill_field').checked == true) {
				element.style.background = GRN;
			} else {
				element.style.background = RED;
			}

		} else {	// finish

			canvas.style.cursor = "default";
			let rect = element.getBoundingClientRect(),
				rX = Math.round(rect.left * COEFF),
				rY = Math.round(rect.top * COEFF),
				rW = Math.round( (rect.right - rect.left) * COEFF),
				rH = Math.round( (rect.bottom - rect.top) * COEFF);
			rect = element = null;

			let fill_form = (parent.document.getElementById('_fill_field').checked == true) ? '_motionDetect_roi' : '_motionDetect_skipIn';
			let dimensions = rX + 'x' + rY + 'x' + rW + 'x' + rH;
			dimensions = (parent.document.getElementById(fill_form).value == '') ? dimensions : ', ' + dimensions;
			parent.document.getElementById(fill_form).value += dimensions;

		}
	}
}
