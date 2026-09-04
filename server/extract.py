"""Bounded extraction preserving source clauses. Runs in a no-network sandbox."""
import json
import re
import subprocess
import sys
import zipfile
import xml.etree.ElementTree as ET

W = '{http://schemas.openxmlformats.org/wordprocessingml/2006/main}'
warnings = []


def val(node, path, default=None):
    child = node.find('/'.join(W + part for part in path.split('/'))) if node is not None else None
    return child.get(W + 'val', default) if child is not None else default


def read_xml(archive, name):
    if name not in archive.namelist():
        return ET.Element('empty')
    raw = archive.read(name)
    if b'<!DOCTYPE' in raw.upper() or b'<!ENTITY' in raw.upper():
        raise ValueError('Небезопасная XML-структура.')
    return ET.fromstring(raw)


def number_text(value, fmt):
    if fmt == 'decimal':
        return str(value)
    if fmt == 'decimalZero':
        return str(value).zfill(2)
    if fmt in ('lowerLetter', 'upperLetter') and 0 < value < 10000:
        text = ''
        while value:
            value, digit = divmod(value - 1, 26)
            text = chr(65 + digit) + text
        return text.lower() if fmt == 'lowerLetter' else text
    if fmt in ('lowerRoman', 'upperRoman') and 0 < value < 4000:
        text = ''
        for n, letters in [(1000,'M'),(900,'CM'),(500,'D'),(400,'CD'),(100,'C'),(90,'XC'),(50,'L'),(40,'XL'),(10,'X'),(9,'IX'),(5,'V'),(4,'IV'),(1,'I')]:
            while value >= n:
                text += letters
                value -= n
        return text.lower() if fmt == 'lowerRoman' else text
    raise ValueError('Нестандартный формат нумерации Word; номер не восстановлен. Проверьте оригинал.')


class Numbering:
    def __init__(self, archive):
        root = read_xml(archive, 'word/numbering.xml')
        self.abstract = {x.get(W+'abstractNumId'): x for x in root.findall(W+'abstractNum')}
        self.instances = {x.get(W+'numId'): x for x in root.findall(W+'num')}
        self.styles = {x.get(W+'styleId'): x for x in read_xml(archive,'word/styles.xml').findall(W+'style')}
        self.default = next((key for key,x in self.styles.items() if x.get(W+'default') == '1' and x.get(W+'type') == 'paragraph'), None)
        self.counts = {}

    def properties(self, paragraph):
        direct = paragraph.find(W+'pPr')
        style_id = val(direct,'pStyle',self.default)
        chain, seen = [], set()
        key = style_id
        while key in self.styles and key not in seen:
            seen.add(key)
            style = self.styles[key]
            chain.insert(0,style.find(W+'pPr'))
            key = val(style,'basedOn')
        properties = {}
        for props in chain + [direct]:
            for name in ['numPr/numId','numPr/ilvl','outlineLvl']:
                value = val(props,name)
                if value is not None:
                    properties[name] = value
        return properties, style_id

    def prefix(self, paragraph):
        props, style_id = self.properties(paragraph)
        heading = props.get('outlineLvl') not in (None,'9')
        num_id = props.get('numPr/numId')
        if num_id in (None,'0'):
            return '', heading, False, False
        try:
            instance = self.instances[num_id]
            abstract = self.abstract[val(instance,'abstractNumId')]
            if abstract.find(W+'numStyleLink') is not None:
                raise ValueError('Связанная нумерация Word требует проверки по оригиналу; номер не восстановлен.')
            levels = {int(x.get(W+'ilvl')):x for x in abstract.findall(W+'lvl')}
            starts = {}
            for override in instance.findall(W+'lvlOverride'):
                depth = int(override.get(W+'ilvl'))
                if override.find(W+'lvl') is not None:
                    levels[depth] = override.find(W+'lvl')
                if val(override,'startOverride') is not None:
                    starts[depth] = int(val(override,'startOverride'))
            depth = int(props.get('numPr/ilvl','0'))
            if paragraph.find(W+'pPr/'+W+'numPr') is None:
                depth = next((n for n,x in levels.items() if val(x,'pStyle') == style_id),depth)
            level = levels[depth]
            if depth not in range(9):
                raise ValueError('Некорректный уровень нумерации Word.')
            counts = self.counts.setdefault(num_id,{})
            for n, definition in levels.items():
                restart = int(val(definition,'lvlRestart',str(n)))
                if n > depth and restart != 0 and depth <= (restart-1 if restart<=n else n-1):
                    counts.pop(n,None)
            start = lambda n: starts.get(n,int(val(levels[n],'start','1')))
            counts[depth] = counts.get(depth,start(depth)-1)+1
            fmt = val(level,'numFmt','decimal')
            pattern = val(level,'lvlText')
            if fmt in ('bullet','none'):
                return (pattern or '') if fmt=='bullet' else '',heading,False,False
            if pattern is None or level.find(W+'lvlPicBulletId') is not None:
                raise ValueError('Нумерация Word не восстановлена; проверьте оригинал.')
            legal = level.find(W+'isLgl') is not None and val(level,'isLgl','1') not in ('0','false','off')
            def replace(match):
                n = int(match.group(1))-1
                if n>depth or n not in levels:
                    raise ValueError('Неоднозначная нумерация Word; проверьте оригинал.')
                return number_text(counts.get(n,start(n)), 'decimal' if legal else val(levels[n],'numFmt','decimal'))
            return re.sub(r'%([1-9])',replace,pattern),heading,False,True
        except (ValueError,KeyError,TypeError) as exc:
            warnings.append(str(exc) if isinstance(exc,ValueError) else 'Определение нумерации Word отсутствует; номер не восстановлен.')
            return '',heading,True,False


def marker(text):
    line = text.split('\n',1)[0].strip()
    named = re.match(r'^(Раздел|Глава|Статья|Приложение)\s+(?:№\s*)?([0-9]+(?:\.[0-9]+)*|[IVXLCDM]+|[А-ЯA-Z])\b',line,re.I)
    if named:
        return named.group(0), named.group(2), 'section', line
    # Dates, amounts, rates and prose references to other clauses are not clause starts.
    if re.match(r'^\d{1,2}\.\d{1,2}\.\d{4}\b',line):
        return None
    # A decimal share reads like a clause number: "4.5 % of the price", "0.5 of a rate".
    # A borrowed number is worse than a missing one, so both are left unnumbered.
    if re.match(r'^\d{1,3}\.\d{1,3}\s*[%‰]',line) or re.match(r'^0\.\d',line):
        return None
    # The number may end the line: PDF layout often puts it above its own text.
    numbered = re.match(r'^((?:\d{1,3}\.)+\d{1,3}[.)]?|\d{1,3}[.)]|[а-яa-z][)]|[IVXLCDM]+[.)])(?:\s+(?=\S)|\s*$)',line)
    if not numbered:
        return None
    raw = numbered.group(1)
    return 'п. '+raw.rstrip('.)'),raw.rstrip('.)'),'clause',''


def structure(paragraphs):
    units = []
    section = ''
    for item in paragraphs:
        text = item['text'].strip()
        if not text:
            continue
        if units and item.get('part','body') != units[-1]['part']:
            section = ''
        found = None if item.get('uncertain') or item.get('table') else marker(text)
        if item.get('numbering') and not found:
            number = item['numbering'].rstrip('.)')
            found = ('п. '+number,number,'clause','')
        heading = item.get('heading') or (len(text)<160 and text.isupper() and not found and not item.get('table'))
        if found:
            label, number, kind, title = found
            if kind == 'section':
                section = label
            elif heading:
                kind, title = 'section',text.split('\n',1)[0]
                label = title
                section = label
            locator = {'label':label,'number':number,'kind':kind,'title':title,'section':section,'status':'preserved'}
        elif heading:
            section = text
            locator = {'label':text,'number':None,'kind':'section','title':text,'section':section,'status':'preserved'}
        else:
            locator = {'label':'Таблица' if item.get('table') else 'Без номера','number':None,'kind':'table' if item.get('table') else 'paragraph','title':'','section':section,'status':'uncertain' if item.get('uncertain') else 'unnumbered'}
        # Natural paragraphs belonging to one clause remain one source clause.
        previous = units[-1] if units else None
        if not found and not heading and not item.get('table') and not item.get('uncertain') and previous and previous['locator']['kind']=='clause' and item.get('part','body')==previous.get('part'):
            previous['text'] += '\n\n'+text
            if item.get('page'):
                previous['pageEnd'] = item['page']
            continue
        # Нумерация бывает и ручной: тогда глубину даёт сам номер, а не список Word.
        depth = min(locator['number'].count('.'),4) if locator.get('number') and locator['kind']=='clause' else 0
        level = max(item.get('level') or 0, depth)
        unit = {'id':'b'+str(len(units)+1),'text':text,'page':item.get('page'),'pageEnd':item.get('page'),'part':item.get('part','body'),
                'level':level,'locator':locator}
        if item.get('bold'):
            unit['bold'] = True
        if item.get('cells'):
            unit['cells'] = item['cells']
        units.append(unit)
    return units


def text_paragraphs(text, page=None):
    current = []
    for line in text.splitlines():
        if not line.strip() or marker(line):
            if current:
                yield {'text':'\n'.join(current),'page':page,'part':'body'}
                current = []
        if line.strip():
            current.append(line.strip())
    if current:
        yield {'text':'\n'.join(current),'page':page,'part':'body'}


def docx_paragraphs(archive):
    numbering = Numbering(archive)
    names = archive.namelist()
    wanted = ['word/document.xml'] + sorted(x for x in names if x in ['word/footnotes.xml','word/endnotes.xml'] or re.match(r'^word/(header|footer)\d+\.xml$',x))
    for name in wanted:
        root = read_xml(archive,name)
        if root.findall('.//'+W+'ins') or root.findall('.//'+W+'del'):
            warnings.append('Есть исправления Word. Проверьте принятую редакцию и нумерацию по оригиналу.')
        if root.findall('.//'+W+'drawing') or root.findall('.//'+W+'pict'):
            warnings.append('Изображения DOCX не распознаны; требуется проверка комплектности.')
        if root.findall('.//'+W+'instrText'):
            warnings.append('Поля Word не пересчитываются; отображённые значения и перекрёстные ссылки проверьте по оригиналу.')
        def paragraph(p):
            prefix,heading,uncertain,numbered = numbering.prefix(p)
            text = ''.join((el.text or '') if el.tag in (W+'t',W+'delText') else '\t' if el.tag==W+'tab' else '\n' if el.tag in (W+'br',W+'cr') else '' for el in p.iter())
            props,_ = numbering.properties(p)
            try:
                level = int(props.get('numPr/ilvl') or (props.get('outlineLvl') if heading else 0) or 0)
            except ValueError:
                level = 0
            runs = [r for r in p.findall(W+'r') if any((el.text or '').strip() for el in r.iter(W+'t'))]
            bold = bool(runs) and all(r.find(W+'rPr/'+W+'b') is not None for r in runs)
            return {'text':(prefix+' ' if prefix else '')+text,'heading':heading,'uncertain':uncertain,'numbering':prefix if numbered else None,
                    'level':min(level,4),'bold':bold,'part':name}
        def walk(node):
            if node.tag == W+'p':
                item = paragraph(node)
                if not item['numbering'] and not item['uncertain'] and not item['heading']:
                    for part in text_paragraphs(item['text']):
                        yield {**item,'text':part['text']}
                else:
                    yield item
            elif node.tag == W+'tbl':
                rows, grid = [], []
                for row in node.findall(W+'tr'):
                    cells = ['\n'.join(paragraph(p)['text'] for p in cell.iter(W+'p')) for cell in row.findall(W+'tc')]
                    grid.append(cells)
                    rows.append(' | '.join(cells))
                yield {'text':'\n'.join(rows),'table':True,'cells':grid,'part':name}
                warnings.append('Таблицы представлены строками и ячейками; объединённые ячейки проверьте по оригиналу.')
            else:
                for child in node:
                    yield from walk(child)
        yield from walk(root)


def main(path, ext):
    if ext == 'docx':
        with zipfile.ZipFile(path) as archive:
            entries = archive.infolist()
            if len(entries)>2000 or sum(x.file_size for x in entries)>40*1024*1024:
                raise ValueError('Превышен безопасный размер распакованного DOCX.')
            if 'word/document.xml' not in archive.namelist():
                raise ValueError('Файл не является документом DOCX.')
            if any('vbaproject' in x.filename.lower() or x.filename.startswith('word/embeddings/') for x in entries):
                raise ValueError('Документы с макросами или вложенными объектами не принимаются.')
            paragraphs = list(docx_paragraphs(archive))
    elif ext == 'pdf':
        out = subprocess.run(['pdftotext','-layout','-enc','UTF-8',path,'-'],capture_output=True,timeout=25,check=True)
        pages = out.stdout.decode('utf-8').split('\f')
        if pages and not pages[-1].strip():
            pages.pop()
        paragraphs = []
        for page,text in enumerate(pages,1):
            if not text.strip():
                warnings.append('Страница %s: нет текстового слоя. OCR пока не подключён.' % page)
            paragraphs.extend(text_paragraphs(text,page))
        warnings.append('PDF: нумерация взята из текстового слоя; порядок колонок и границы пунктов требуют проверки по оригиналу.')
    elif ext == 'doc':
        out = subprocess.run(['antiword','-m','UTF-8.txt',path],capture_output=True,timeout=25,check=True)
        paragraphs = list(text_paragraphs(out.stdout.decode('utf-8')))
        warnings.append('DOC: номера взяты из извлечённого текста; разметку, списки, изображения и исправления проверьте по оригиналу.')
    else:
        raise ValueError('Поддерживаются PDF, DOC и DOCX.')
    blocks = structure(paragraphs)
    if not blocks:
        raise ValueError('Не удалось извлечь текст. Для сканов требуется OCR; анализ недоступен.')
    if sum(len(x['text']) for x in blocks)>240000 or len(blocks)>4000:
        raise ValueError('Документ превышает лимит пилота: 240 000 символов / 4000 элементов структуры. Текст не обрезан; анализ не выполнен.')
    return {'blocks':blocks,'warnings':sorted(set(warnings)),'extractor':'structure-v3'}


if __name__ == '__main__':
    try:
        print(json.dumps(main(*sys.argv[1:3]),ensure_ascii=False))
    except Exception as exc:
        message = str(exc) if isinstance(exc,ValueError) else 'Не удалось прочитать документ: повреждён, защищён паролем или формат не поддерживается.'
        print(json.dumps({'blocks':[],'warnings':[message],'extractor':'structure-v3'},ensure_ascii=False))
        sys.exit(1)
