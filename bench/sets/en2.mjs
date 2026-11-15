/** 5 English questions added in s1, on topics the original en set never covered. truth pages are 1-based PDF pages. */
const DC = '项目/砖块/English/Lessons-in-Electric-Circuits-Vol1-DC.pdf';
const AC = '项目/砖块/English/Lessons-in-Electric-Circuits-Vol2-AC.pdf';
const SEMI = '项目/砖块/English/Lessons-in-Electric-Circuits-Vol3-Semiconductors.pdf';
const DIGI = '项目/砖块/English/Lessons-in-Electric-Circuits-Vol4-Digital.pdf';
const UP2 = '项目/砖块/English/OpenStax-University-Physics-Vol2.pdf';

const has = (needle) => (name) => name.includes(needle);
const LESSONS = has('Lessons-in-Electric-Circuits');

/** [query, truth path, truth pages, topic predicate, English paraphrase, answer terms] */
export const items = [
  ['How does the mesh current method solve a circuit', DC, [351, 352, 353], LESSONS, 'mesh current method steps', ['mesh current']],
  ['Why does inductive reactance increase with frequency', AC, [72, 73], LESSONS, 'inductive reactance frequency dependence', ['inductive reactance']],
  ['What is a JFET and how is its gate junction biased', SEMI, [74, 75], LESSONS, 'JFET gate junction reverse bias', ['JFET']],
  ['Why is a CMOS inverter simpler than a TTL gate', DIGI, [82, 83], LESSONS, 'CMOS inverter versus TTL', ['CMOS inverter']],
  ['How is magnetic flux through a surface defined', UP2, [578, 579], has('OpenStax'), 'magnetic flux definition surface', ['magnetic flux']],
];
