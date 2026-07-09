import {
  formatWorkbookFieldValue,
  revisedDealTeamNames
} from "./deal-formatting";
import type { FieldValue, ModuleKey, WorkspaceRecord } from "./data";

type ExportColumn = {
  key: string;
  label: string;
  width?: number;
};

type SheetCell = {
  style?: number;
  value: string;
};

type SheetDefinition = {
  columns?: ExportColumn[];
  name: string;
  rows: SheetCell[][];
};

type ZipFile = {
  data: Uint8Array;
  name: string;
};

const encoder = new TextEncoder();

export function exportWorkbookXlsx(
  rows: WorkspaceRecord[],
  columns: ExportColumn[],
  moduleKey: ModuleKey
) {
  const workbook = buildWorkbookBlob(rows, columns, moduleKey);
  const url = URL.createObjectURL(workbook);
  const link = document.createElement("a");
  link.href = url;
  link.download = `${moduleKey}.xlsx`;
  link.click();
  URL.revokeObjectURL(url);
}

export function buildWorkbookBlob(
  rows: WorkspaceRecord[],
  columns: ExportColumn[],
  moduleKey: ModuleKey
) {
  const sheets = [
    buildDataSheet(rows, columns, moduleKey),
    buildRevisedNamesSheet()
  ];
  const files = buildXlsxFiles(sheets);
  return new Blob([createZip(files)], {
    type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
  });
}

function buildDataSheet(
  rows: WorkspaceRecord[],
  columns: ExportColumn[],
  moduleKey: ModuleKey
): SheetDefinition {
  const header = columns.map((column) => ({
    style: 1,
    value: column.label
  }));
  const body = rows.map((row) => {
    const isSection = row.kind === "section" || row.tone === "dark";

    return columns.map((column, columnIndex) => ({
      style: isSection ? 1 : undefined,
      value: cellValueForExport(row, column, columnIndex, moduleKey)
    }));
  });

  return {
    columns,
    name: moduleKey,
    rows: [header, ...body]
  };
}

function cellValueForExport(
  row: WorkspaceRecord,
  column: ExportColumn,
  columnIndex: number,
  moduleKey: ModuleKey
) {
  const rawValue = row.fields[column.key] ?? (columnIndex === 0 ? row.title : "");
  return formatWorkbookFieldValue(moduleKey, column.key, rawValue);
}

function buildRevisedNamesSheet(): SheetDefinition {
  const rows: SheetCell[][] = [
    [
      { style: 1, value: "MA (Original Name)" },
      { style: 1, value: "MA (Abbreviated Name)" },
      { value: "" },
      { style: 1, value: "UW (Original Name)" },
      { style: 1, value: "UW (Abbreviated Name)" },
      { value: "" },
      { style: 1, value: "BC (Original Name)" },
      { style: 1, value: "BC (Abbreviated Name)" }
    ]
  ];
  const maxRows = Math.max(
    revisedDealTeamNames.MA.length,
    revisedDealTeamNames.UW.length,
    revisedDealTeamNames.BC.length
  );

  for (let index = 0; index < maxRows; index += 1) {
    const ma = revisedDealTeamNames.MA[index];
    const uw = revisedDealTeamNames.UW[index];
    const bc = revisedDealTeamNames.BC[index];

    rows.push([
      { value: ma?.original ?? "" },
      { value: ma?.shortName ?? "" },
      { value: "" },
      { value: uw?.original ?? "" },
      { value: uw?.shortName ?? "" },
      { value: "" },
      { value: bc?.original ?? "" },
      { value: bc?.shortName ?? "" }
    ]);
  }

  return {
    columns: [
      { key: "maOriginal", label: "MA (Original Name)", width: 260 },
      { key: "maShort", label: "MA (Abbreviated Name)", width: 150 },
      { key: "spacer1", label: "", width: 40 },
      { key: "uwOriginal", label: "UW (Original Name)", width: 230 },
      { key: "uwShort", label: "UW (Abbreviated Name)", width: 150 },
      { key: "spacer2", label: "", width: 40 },
      { key: "bcOriginal", label: "BC (Original Name)", width: 245 },
      { key: "bcShort", label: "BC (Abbreviated Name)", width: 150 }
    ],
    name: "Revised Names",
    rows
  };
}

function buildXlsxFiles(sheets: SheetDefinition[]): ZipFile[] {
  return [
    textFile("[Content_Types].xml", contentTypesXml(sheets.length)),
    textFile("_rels/.rels", rootRelsXml()),
    textFile("docProps/app.xml", appXml(sheets)),
    textFile("docProps/core.xml", coreXml()),
    textFile("xl/workbook.xml", workbookXml(sheets)),
    textFile("xl/_rels/workbook.xml.rels", workbookRelsXml(sheets.length)),
    textFile("xl/styles.xml", stylesXml()),
    ...sheets.map((sheet, index) => textFile(`xl/worksheets/sheet${index + 1}.xml`, worksheetXml(sheet)))
  ];
}

function worksheetXml(sheet: SheetDefinition) {
  const maxColumns = Math.max(...sheet.rows.map((row) => row.length), sheet.columns?.length ?? 0, 1);
  const maxRows = Math.max(sheet.rows.length, 1);
  const dimension = `A1:${columnName(maxColumns - 1)}${maxRows}`;
  const cols = sheet.columns?.length
    ? `<cols>${sheet.columns
        .map((column, index) => {
          const width = Math.max(8, Math.round((column.width ?? 150) / 7));
          return `<col min="${index + 1}" max="${index + 1}" width="${width}" customWidth="1"/>`;
        })
        .join("")}</cols>`
    : "";
  const rows = sheet.rows
    .map((row, rowIndex) => {
      const rowNumber = rowIndex + 1;
      const cells = row
        .map((cell, columnIndex) => {
          const reference = `${columnName(columnIndex)}${rowNumber}`;
          const style = cell.style ? ` s="${cell.style}"` : "";

          return `<c r="${reference}" t="inlineStr"${style}><is><t>${escapeXml(cell.value)}</t></is></c>`;
        })
        .join("");

      return `<row r="${rowNumber}">${cells}</row>`;
    })
    .join("");

  return xmlDeclaration(
    `<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><dimension ref="${dimension}"/><sheetViews><sheetView workbookViewId="0" showGridLines="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews>${cols}<sheetData>${rows}</sheetData><autoFilter ref="${dimension}"/></worksheet>`
  );
}

function contentTypesXml(sheetCount: number) {
  const sheets = Array.from({ length: sheetCount }, (_, index) =>
    `<Override PartName="/xl/worksheets/sheet${index + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`
  ).join("");

  return xmlDeclaration(
    `<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/><Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>${sheets}</Types>`
  );
}

function rootRelsXml() {
  return xmlDeclaration(
    `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/><Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/extended-properties" Target="docProps/app.xml"/></Relationships>`
  );
}

function workbookXml(sheets: SheetDefinition[]) {
  return xmlDeclaration(
    `<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>${sheets
      .map(
        (sheet, index) =>
          `<sheet name="${escapeXmlAttribute(sheet.name)}" sheetId="${index + 1}" r:id="rId${index + 1}"/>`
      )
      .join("")}</sheets></workbook>`
  );
}

function workbookRelsXml(sheetCount: number) {
  const sheetRels = Array.from({ length: sheetCount }, (_, index) =>
    `<Relationship Id="rId${index + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${index + 1}.xml"/>`
  ).join("");

  return xmlDeclaration(
    `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${sheetRels}<Relationship Id="rId${sheetCount + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>`
  );
}

function stylesXml() {
  return xmlDeclaration(
    `<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><color rgb="FFFFFFFF"/><name val="Calibri"/></font></fonts><fills count="3"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill><fill><patternFill patternType="solid"><fgColor rgb="FF003468"/><bgColor indexed="64"/></patternFill></fill></fills><borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="2"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="0" fontId="1" fillId="2" borderId="0" xfId="0" applyFont="1" applyFill="1"/></cellXfs><cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles></styleSheet>`
  );
}

function appXml(sheets: SheetDefinition[]) {
  return xmlDeclaration(
    `<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties" xmlns:vt="http://schemas.openxmlformats.org/officeDocument/2006/docPropsVTypes"><Application>Ramirez K-12 Workbook</Application><TitlesOfParts><vt:vector size="${sheets.length}" baseType="lpstr">${sheets
      .map((sheet) => `<vt:lpstr>${escapeXml(sheet.name)}</vt:lpstr>`)
      .join("")}</vt:vector></TitlesOfParts></Properties>`
  );
}

function coreXml() {
  const now = new Date().toISOString();

  return xmlDeclaration(
    `<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"><dc:title>K-12 Workbook Export</dc:title><dc:creator>Ramirez K-12 Workbook</dc:creator><cp:lastModifiedBy>Ramirez K-12 Workbook</cp:lastModifiedBy><dcterms:created xsi:type="dcterms:W3CDTF">${now}</dcterms:created><dcterms:modified xsi:type="dcterms:W3CDTF">${now}</dcterms:modified></cp:coreProperties>`
  );
}

function createZip(files: ZipFile[]) {
  const localParts: Uint8Array[] = [];
  const centralParts: Uint8Array[] = [];
  let offset = 0;

  for (const file of files) {
    const name = encoder.encode(file.name);
    const crc = crc32(file.data);
    const dosDate = (1 << 5) | 1;
    const localHeader = new Uint8Array(30 + name.length);
    const localView = new DataView(localHeader.buffer);

    localView.setUint32(0, 0x04034b50, true);
    localView.setUint16(4, 20, true);
    localView.setUint16(6, 0, true);
    localView.setUint16(8, 0, true);
    localView.setUint16(10, 0, true);
    localView.setUint16(12, dosDate, true);
    localView.setUint32(14, crc, true);
    localView.setUint32(18, file.data.length, true);
    localView.setUint32(22, file.data.length, true);
    localView.setUint16(26, name.length, true);
    localHeader.set(name, 30);
    localParts.push(localHeader, file.data);

    const centralHeader = new Uint8Array(46 + name.length);
    const centralView = new DataView(centralHeader.buffer);
    centralView.setUint32(0, 0x02014b50, true);
    centralView.setUint16(4, 20, true);
    centralView.setUint16(6, 20, true);
    centralView.setUint16(8, 0, true);
    centralView.setUint16(10, 0, true);
    centralView.setUint16(12, 0, true);
    centralView.setUint16(14, dosDate, true);
    centralView.setUint32(16, crc, true);
    centralView.setUint32(20, file.data.length, true);
    centralView.setUint32(24, file.data.length, true);
    centralView.setUint16(28, name.length, true);
    centralView.setUint32(42, offset, true);
    centralHeader.set(name, 46);
    centralParts.push(centralHeader);

    offset += localHeader.length + file.data.length;
  }

  const centralOffset = offset;
  const centralSize = centralParts.reduce((sum, part) => sum + part.length, 0);
  const end = new Uint8Array(22);
  const endView = new DataView(end.buffer);
  endView.setUint32(0, 0x06054b50, true);
  endView.setUint16(8, files.length, true);
  endView.setUint16(10, files.length, true);
  endView.setUint32(12, centralSize, true);
  endView.setUint32(16, centralOffset, true);

  return concatUint8Arrays([...localParts, ...centralParts, end]);
}

function crc32(data: Uint8Array) {
  let crc = 0xffffffff;

  for (const byte of data) {
    crc = crcTable[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  }

  return (crc ^ 0xffffffff) >>> 0;
}

const crcTable = Array.from({ length: 256 }, (_, index) => {
  let value = index;

  for (let bit = 0; bit < 8; bit += 1) {
    value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
  }

  return value >>> 0;
});

function concatUint8Arrays(parts: Uint8Array[]) {
  const totalLength = parts.reduce((sum, part) => sum + part.length, 0);
  const output = new Uint8Array(totalLength);
  let offset = 0;

  for (const part of parts) {
    output.set(part, offset);
    offset += part.length;
  }

  return output;
}

function textFile(name: string, text: string): ZipFile {
  return {
    data: encoder.encode(text),
    name
  };
}

function xmlDeclaration(value: string) {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>${value}`;
}

function escapeXml(value: FieldValue | null | undefined) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function escapeXmlAttribute(value: FieldValue | null | undefined) {
  return escapeXml(value).replace(/"/g, "&quot;");
}

function columnName(index: number) {
  let name = "";
  let current = index + 1;

  while (current > 0) {
    const remainder = (current - 1) % 26;
    name = String.fromCharCode(65 + remainder) + name;
    current = Math.floor((current - 1) / 26);
  }

  return name;
}
