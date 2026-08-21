/* 엑셀(.xlsx) 파일을 브라우저에서 직접 만드는 아주 작은 도구.
   외부 라이브러리를 쓰지 않으려고 직접 만들었습니다.
   .xlsx 는 사실 XML 몇 개를 ZIP으로 묶은 것이라, ZIP만 만들 줄 알면 됩니다. */
(function (global) {
  "use strict";

  // ── CRC32 (ZIP이 요구하는 검사값) ──────────────────────
  var TABLE = (function () {
    var t = new Uint32Array(256);
    for (var i = 0; i < 256; i++) {
      var c = i;
      for (var k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
      t[i] = c >>> 0;
    }
    return t;
  })();

  function crc32(bytes) {
    var c = 0xFFFFFFFF;
    for (var i = 0; i < bytes.length; i++) c = TABLE[(c ^ bytes[i]) & 0xFF] ^ (c >>> 8);
    return (c ^ 0xFFFFFFFF) >>> 0;
  }

  var enc = new TextEncoder();

  // ── ZIP 만들기 (압축 없이 그대로 담기) ────────────────
  function makeZip(files) {
    var parts = [], central = [], offset = 0;

    files.forEach(function (f) {
      var nameBytes = enc.encode(f.name);
      var data = f.data;
      var crc = crc32(data);

      var local = new Uint8Array(30 + nameBytes.length);
      var lv = new DataView(local.buffer);
      lv.setUint32(0, 0x04034b50, true);   // 서명
      lv.setUint16(4, 20, true);           // 필요 버전
      lv.setUint16(6, 0x0800, true);       // 파일명 UTF-8
      lv.setUint16(8, 0, true);            // 압축 안 함
      lv.setUint16(10, 0, true);           // 시각
      lv.setUint16(12, 0x0021, true);      // 날짜(1980-01-01)
      lv.setUint32(14, crc, true);
      lv.setUint32(18, data.length, true);
      lv.setUint32(22, data.length, true);
      lv.setUint16(26, nameBytes.length, true);
      lv.setUint16(28, 0, true);
      local.set(nameBytes, 30);

      parts.push(local, data);

      var cd = new Uint8Array(46 + nameBytes.length);
      var cv = new DataView(cd.buffer);
      cv.setUint32(0, 0x02014b50, true);
      cv.setUint16(4, 20, true);
      cv.setUint16(6, 20, true);
      cv.setUint16(8, 0x0800, true);
      cv.setUint16(10, 0, true);
      cv.setUint16(12, 0, true);
      cv.setUint16(14, 0x0021, true);
      cv.setUint32(16, crc, true);
      cv.setUint32(20, data.length, true);
      cv.setUint32(24, data.length, true);
      cv.setUint16(28, nameBytes.length, true);
      cv.setUint32(42, offset, true);
      cd.set(nameBytes, 46);
      central.push(cd);

      offset += local.length + data.length;
    });

    var cdSize = central.reduce(function (s, c) { return s + c.length; }, 0);
    var end = new Uint8Array(22);
    var ev = new DataView(end.buffer);
    ev.setUint32(0, 0x06054b50, true);
    ev.setUint16(8, files.length, true);
    ev.setUint16(10, files.length, true);
    ev.setUint32(12, cdSize, true);
    ev.setUint32(16, offset, true);

    return new Blob(parts.concat(central, [end]),
      { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" });
  }

  // ── 엑셀 XML ──────────────────────────────────────────
  function esc(s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;" }[c];
    }).replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, "");
  }

  function colName(n) {
    var s = "";
    while (n >= 0) { s = String.fromCharCode(65 + (n % 26)) + s; n = Math.floor(n / 26) - 1; }
    return s;
  }

  function sheetXml(rows) {
    var out = [];
    rows.forEach(function (row, r) {
      var cells = [];
      row.forEach(function (val, c) {
        if (val === null || val === undefined || val === "") return;
        var ref = colName(c) + (r + 1);
        if (typeof val === "number" && isFinite(val)) {
          cells.push('<c r="' + ref + '"><v>' + val + "</v></c>");
        } else {
          cells.push('<c r="' + ref + '" t="inlineStr"><is><t xml:space="preserve">'
            + esc(val) + "</t></is></c>");
        }
      });
      out.push('<row r="' + (r + 1) + '">' + cells.join("") + "</row>");
    });

    return '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
      + '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">'
      + '<sheetData>' + out.join("") + '</sheetData></worksheet>';
  }

  /**
   * 표(2차원 배열)를 .xlsx 파일로 내려받게 한다.
   * @param {Array<Array>} rows  첫 줄은 보통 제목 줄
   * @param {string} filename    저장될 파일 이름
   * @param {string} sheetName   시트 이름
   */
  function download(rows, filename, sheetName) {
    sheetName = (sheetName || "Sheet1").replace(/[\\\/\?\*\[\]:]/g, " ").slice(0, 31);

    var files = [
      {
        name: "[Content_Types].xml",
        data: enc.encode('<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
          + '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'
          + '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>'
          + '<Default Extension="xml" ContentType="application/xml"/>'
          + '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>'
          + '<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>'
          + '</Types>')
      },
      {
        name: "_rels/.rels",
        data: enc.encode('<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
          + '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
          + '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>'
          + '</Relationships>')
      },
      {
        name: "xl/workbook.xml",
        data: enc.encode('<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
          + '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"'
          + ' xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">'
          + '<sheets><sheet name="' + esc(sheetName) + '" sheetId="1" r:id="rId1"/></sheets></workbook>')
      },
      {
        name: "xl/_rels/workbook.xml.rels",
        data: enc.encode('<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
          + '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
          + '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>'
          + '</Relationships>')
      },
      { name: "xl/worksheets/sheet1.xml", data: enc.encode(sheetXml(rows)) }
    ];

    var blob = makeZip(files);
    var url = URL.createObjectURL(blob);
    var a = document.createElement("a");
    a.href = url;
    a.download = filename.slice(-5) === ".xlsx" ? filename : filename + ".xlsx";
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
  }

  global.MiniXlsx = { download: download };
})(window);
