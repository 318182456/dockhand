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
