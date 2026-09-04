import io
import pathlib
import runpy
import unittest
import zipfile

extract = runpy.run_path(str(pathlib.Path(__file__).parent.parent/'server'/'extract.py'))
NS='http://schemas.openxmlformats.org/wordprocessingml/2006/main'

def paragraph(text, level=None, num=1, style=None):
    props=('' if level is None else f'<w:numPr><w:ilvl w:val="{level}"/><w:numId w:val="{num}"/></w:numPr>')+('' if not style else f'<w:pStyle w:val="{style}"/>')
    return f'<w:p><w:pPr>{props}</w:pPr><w:r><w:t>{text}</w:t></w:r></w:p>'

def document(body, numbering='', styles=''):
    data=io.BytesIO()
    with zipfile.ZipFile(data,'w') as archive:
        archive.writestr('word/document.xml',f'<w:document xmlns:w="{NS}"><w:body>{body}</w:body></w:document>')
        archive.writestr('word/numbering.xml',f'<w:numbering xmlns:w="{NS}">{numbering}</w:numbering>')
        archive.writestr('word/styles.xml',f'<w:styles xmlns:w="{NS}">{styles}</w:styles>')
    with zipfile.ZipFile(data) as archive:
        return extract['structure'](list(extract['docx_paragraphs'](archive)))

NUMBERING='''<w:abstractNum w:abstractNumId="0">
<w:lvl w:ilvl="0"><w:start w:val="1"/><w:numFmt w:val="decimal"/><w:lvlText w:val="%1."/></w:lvl>
<w:lvl w:ilvl="1"><w:start w:val="1"/><w:numFmt w:val="decimal"/><w:lvlText w:val="%1.%2."/></w:lvl>
</w:abstractNum><w:num w:numId="1"><w:abstractNumId w:val="0"/></w:num>
<w:num w:numId="2"><w:abstractNumId w:val="0"/><w:lvlOverride w:ilvl="0"><w:startOverride w:val="7"/></w:lvlOverride></w:num>'''

class Extraction(unittest.TestCase):
    def test_auto_multilevel_and_override(self):
        items=document(''.join([paragraph('Предмет',0),paragraph('Внедрение системы',1),paragraph('Без дополнительной оплаты'),paragraph('Сопровождение',1),paragraph('Приёмка',0),paragraph('Акт',1),paragraph('Другое приложение',0,2),paragraph('Срок',1,2)]),NUMBERING)
        self.assertEqual([p['locator']['number'] for p in items],['1','1.1','1.2','2','2.1','7','7.1'])
        self.assertIn('\n\nБез дополнительной оплаты',items[1]['text'])
        self.assertTrue(items[1]['text'].startswith('1.1.'))

    def test_style_inheritance_and_resume(self):
        styles='<w:style w:type="paragraph" w:styleId="Base"><w:pPr><w:numPr><w:numId w:val="1"/><w:ilvl w:val="0"/></w:numPr><w:outlineLvl w:val="0"/></w:pPr></w:style><w:style w:type="paragraph" w:styleId="Child"><w:basedOn w:val="Base"/></w:style>'
        items=document(paragraph('Предмет',style='Child')+paragraph('Вводный текст')+paragraph('Оплата',style='Child'),NUMBERING,styles)
        self.assertEqual(items[0]['locator']['kind'],'section')
        self.assertTrue(items[2]['text'].startswith('2. Оплата'))

    def test_never_restart_and_roman(self):
        definition=NUMBERING.replace('<w:numFmt w:val="decimal"/><w:lvlText w:val="%1.%2."/>','<w:numFmt w:val="lowerRoman"/><w:lvlRestart w:val="0"/><w:lvlText w:val="%1.%2."/>')
        items=document(paragraph('Первый',0)+paragraph('Пункт',1)+paragraph('Второй',0)+paragraph('Пункт',1),definition)
        self.assertTrue(items[-1]['text'].startswith('2.ii.'))

    def test_literal_clauses_not_artificial_chunks(self):
        paragraphs=list(extract['text_paragraphs']('Раздел II. Оплата\n\n2.1. Оплата по акту\nв течение 10 дней\n2.2. Аванс отсутствует',1))
        items=extract['structure'](paragraphs+[{'text':'Продолжение условия на следующей странице','page':2,'part':'body'}])
        self.assertEqual(len(items),3)
        self.assertEqual(items[-1]['locator']['label'],'п. 2.2')
        self.assertEqual(items[-1]['locator']['section'],'Раздел II')
        self.assertEqual(items[-1]['pageEnd'],2)
        self.assertIsNone(extract['marker']('03.09.2026 Дата договора'))
        self.assertIsNone(extract['marker']('Согласно п. 5.1 договора'))

    def test_uncertain_does_not_invent_numbers(self):
        items=document(paragraph('Условие без определения списка',0), '')
        self.assertEqual(items[0]['locator']['status'],'uncertain')
        self.assertIsNone(items[0]['locator']['number'])
        self.assertFalse(items[0]['text'].startswith('1.'))

    def test_every_numbering_style_is_recognised(self):
        for line, label in [('1. Общие положения','п. 1'),('2) Порядок оплаты','п. 2'),('а) первый подпункт','п. а'),
                            ('IV. Ответственность','п. IV'),('1.2.3.4. Глубокий пункт','п. 1.2.3.4'),('2.1 Без точки в конце','п. 2.1'),
                            ('Раздел 3. Приёмка','Раздел 3'),('Статья 5 Ответственность','Статья 5'),
                            ('Глава II Общие условия','Глава II'),('Приложение № 2 Смета','Приложение № 2')]:
            self.assertEqual(extract['marker'](line)[0], label, line)

    def test_numbers_are_never_borrowed_from_prose(self):
        for line in ['4.5 % от суммы договора','0.5 ставки специалиста','03.09.2026 Дата договора',
                     'Согласно п. 5.1 договора','1 500 000 рублей составляет цена']:
            self.assertIsNone(extract['marker'](line), line)

    def test_number_on_its_own_line_keeps_the_clause(self):
        items=extract['structure'](list(extract['text_paragraphs']('5.\nИсполнитель обеспечивает доступ.\n\n6.1\nОплата в течение 10 дней.',1)))
        self.assertEqual([p['locator']['label'] for p in items],['п. 5','п. 6.1'])

    def test_same_number_in_two_parts_stays_distinguishable(self):
        items=extract['structure'](list(extract['text_paragraphs']('Раздел 1. Предмет\n\n1.1. Работы удалённо.\n\nПриложение № 2 Смета\n\n1.1. Стоимость этапа.',1)))
        clauses=[p for p in items if p['locator']['kind']=='clause']
        self.assertEqual([p['locator']['label'] for p in clauses],['п. 1.1','п. 1.1'])
        self.assertEqual([p['locator']['section'] for p in clauses],['Раздел 1','Приложение № 2'])

    def test_tables_keep_cells_and_text(self):
        table='<w:tbl><w:tr><w:tc>'+paragraph('Срок')+'</w:tc><w:tc>'+paragraph('10 дней')+'</w:tc></w:tr></w:tbl>'
        items=document(paragraph('1. Условия')+table+paragraph('2. Оплата'))
        self.assertEqual(items[1]['text'],'Срок | 10 дней')
        self.assertEqual(items[1]['locator']['kind'],'table')
        self.assertEqual(items[1]['cells'],[['Срок','10 дней']])

    def test_structure_carries_nesting_and_emphasis(self):
        items=document(''.join([paragraph('Предмет',0),paragraph('Внедрение системы',1)]),NUMBERING)
        self.assertEqual([p['level'] for p in items],[0,1])
        bold='<w:p><w:pPr/><w:r><w:rPr><w:b/></w:rPr><w:t>ВАЖНОЕ УСЛОВИЕ ДОГОВОРА</w:t></w:r></w:p>'
        items=document(bold+paragraph('Обычный абзац договора без выделения'))
        self.assertTrue(items[0].get('bold'))
        self.assertFalse(items[1].get('bold'))
        # Текст не меняется: по нему сверяются цитаты.
        self.assertEqual(items[0]['text'],'ВАЖНОЕ УСЛОВИЕ ДОГОВОРА')

unittest.main()
