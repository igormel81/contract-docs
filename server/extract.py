"""Bounded extraction. Production executes this in a no-network bubblewrap sandbox."""
import json
import subprocess
import sys
import zipfile
import xml.etree.ElementTree as ET

path, ext = sys.argv[1:3]
blocks = []
warnings = []
MAX_CHARS = 240000

def add(text, page=None):
    text = text.strip()
    if text:
        blocks.append({"id": "b" + str(len(blocks) + 1), "page": page, "text": text})

try:
    if ext == 'docx':
        with zipfile.ZipFile(path) as archive:
            entries = archive.infolist()
            if len(entries) > 2000 or sum(x.file_size for x in entries) > 40 * 1024 * 1024:
                raise ValueError('Превышен безопасный размер распакованного DOCX.')
            names = archive.namelist()
            if 'word/document.xml' not in names:
                raise ValueError('Файл не является документом DOCX.')
            if any('vbaproject' in x.lower() or x.startswith('word/embeddings/') for x in names):
                raise ValueError('Документы с макросами или вложенными объектами не принимаются.')
            wanted = [x for x in names if x == 'word/document.xml' or x in ['word/footnotes.xml', 'word/endnotes.xml'] or x.startswith('word/header') or x.startswith('word/footer')]
            w = '{http://schemas.openxmlformats.org/wordprocessingml/2006/main}'
            for name in wanted:
                xml = archive.read(name)
                if b'<!DOCTYPE' in xml or b'<!ENTITY' in xml:
                    raise ValueError('Небезопасная XML-структура.')
                root = ET.fromstring(xml)
                if root.findall('.//' + w + 'ins') or root.findall('.//' + w + 'del'):
                    warnings.append('Есть исправления Word. Проверьте принятую редакцию по оригиналу.')
                if root.findall('.//' + w + 'drawing') or root.findall('.//' + w + 'pict'):
                    warnings.append('Изображения DOCX не распознаны; требуется проверка комплектности.')
                for paragraph in root.iter(w + 'p'):
                    add(''.join(el.text or '' for el in paragraph.iter() if el.tag in [w + 't', w + 'delText']))
    elif ext == 'pdf':
        out = subprocess.run(['pdftotext', '-layout', '-enc', 'UTF-8', path, '-'], capture_output=True, timeout=25, check=True)
        pages = out.stdout.decode('utf-8').split('\f')
        if pages and not pages[-1].strip():
            pages.pop()
        for page, text in enumerate(pages, 1):
            if not text.strip():
                warnings.append('Страница %s: нет текстового слоя. OCR пока не подключён.' % page)
            for paragraph in text.split('\n\n'):
                add(paragraph, page)
    elif ext == 'doc':
        out = subprocess.run(['antiword', '-m', 'UTF-8.txt', path], capture_output=True, timeout=25, check=True)
        for paragraph in out.stdout.decode('utf-8').split('\n\n'):
            add(paragraph)
        warnings.append('DOC: извлечён текст; разметку, изображения и исправления проверьте по оригиналу.')
    else:
        raise ValueError('Поддерживаются PDF, DOC и DOCX.')
    if not blocks:
        raise ValueError('Не удалось извлечь текст. Для сканов требуется OCR; анализ недоступен.')
    if sum(len(x['text']) for x in blocks) > MAX_CHARS or len(blocks) > 4000:
        raise ValueError('Документ превышает лимит пилота: 240 000 символов / 4000 фрагментов. Текст не обрезан; анализ не выполнен.')
    print(json.dumps({'blocks': blocks, 'warnings': sorted(set(warnings)), 'extractor': 'text-v1'}, ensure_ascii=False))
except Exception as exc:
    message = str(exc) if isinstance(exc, ValueError) else 'Не удалось прочитать документ: повреждён, защищён паролем или формат не поддерживается.'
    print(json.dumps({'blocks': [], 'warnings': [message], 'extractor': 'text-v1'}, ensure_ascii=False))
    sys.exit(1)
