// 输入既可以是原始日志,也可以是 ANSI 转义后的 HTML;只识别预拉取生成的固定标记。
// 每个 session/image/layer 保留首次出现的位置,用最后一次采样替换该行。
function __zhCompactPullLines(text) {
	if (text.indexOf('@@zhpull:') === -1) return text;
	var positions = new Map();
	var result = [];
	for (var line of text.split('\n')) {
		var marker = /@@zhpull:((?:[A-Za-z0-9_%:.-]|<[^>]+>)+)@@ /.exec(line);
		if (!marker) { result.push(line); continue; }
		var key = marker[1].replace(/<[^>]+>/g, '');
		var clean = line.slice(0, marker.index) + line.slice(marker.index + marker[0].length);
		if (positions.has(key)) result[positions.get(key)] = clean;
		else { positions.set(key, result.length); result.push(clean); }
	}
	return result.join('\n');
}

// 自更新弹窗每一步持有自己的日志数组;只保留层行的索引,不积累隐藏日志副本。
var __zhSelfUpdateRows = new WeakMap();
function __zhAppendPullLog(step, message) {
	var rows = __zhSelfUpdateRows.get(step);
	if (!rows) { rows = new Map(); __zhSelfUpdateRows.set(step, rows); }
	var marker = /@@zhpull:([A-Za-z0-9_%:.-]+)@@ /.exec(message);
	var logs = step.logs.slice();
	if (!marker) { logs.push(message); return logs; }
	var clean = message.slice(0, marker.index) + message.slice(marker.index + marker[0].length);
	if (rows.has(marker[1])) logs[rows.get(marker[1])] = clean;
	else { rows.set(marker[1], logs.length); logs.push(clean); }
	return logs;
}
