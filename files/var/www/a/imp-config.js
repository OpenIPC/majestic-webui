function callImp(command, value) {
    if (["flip", "mirror"].includes(command)) {
        command = "flip"
        value = 0
        if (document.querySelector('#flip').checked) value = (1 << 1)
        if (document.querySelector('#mirror').checked) value += 1
    } else if (["aiaec", "aihpf"].includes(command)) {
        value = (value === 1) ? "on" : "off"
    } else if (["ains"].includes(command)) {
        if (value === -1) value = "off"
    } else if (["setosdpos_x", "setosdpos_y"].includes(command)) {
        command = 'setosdpos'
        value = '1' +
            '+' + document.querySelector('#setosdpos_x').value +
            '+' + document.querySelector('#setosdpos_y').value +
            '+1087+75';
    } else if (["whitebalance_mode", "whitebalance_rgain", "whitebalance_bgain"].includes(command)) {
        command = 'whitebalance'
        value = document.querySelector('#whitebalance_mode').value +
            '+' + document.querySelector('#whitebalance_rgain').value +
            '+' + document.querySelector('#whitebalance_bgain').value;
    }

    const xhr = new XMLHttpRequest();
    xhr.open('GET', '/cgi-bin/j/imp.cgi?cmd=' + command + '&val=' + value);
    xhr.send();

    document.querySelector('#savechanges').classList.remove('d-none');
}

// numbers
document.querySelectorAll('input[type=number]').forEach(el => {
    el.autocomplete = "off"
    el.addEventListener('change', ev => callImp(ev.target.name, ev.target.value))
});

// checkboxes
document.querySelectorAll('input[type=checkbox]').forEach(el => {
    el.autocomplete = "off"
    el.addEventListener('change', ev => callImp(ev.target.name, ev.target.checked ? 1 : 0))
});

// radios
document.querySelectorAll('input[type=radio]').forEach(el => {
    el.autocomplete = "off"
    el.addEventListener('change', ev => callImp(ev.target.name, ev.target.value))
});

// ranges
document.querySelectorAll('input[type=range]').forEach(el => {
    el.addEventListener('change', ev => callImp(ev.target.id.replace('-range', ''), ev.target.value))
});

// selects
document.querySelectorAll('select').forEach(el => {
    el.addEventListener('change', ev => callImp(ev.target.id, ev.target.value))
});