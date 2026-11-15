/** 17 English questions over five open-licensed textbooks (2,987 pages). */
const BASE = '项目/砖块/English/';
const DC = BASE + 'Lessons-in-Electric-Circuits-Vol1-DC.pdf';
const AC = BASE + 'Lessons-in-Electric-Circuits-Vol2-AC.pdf';
const SEMI = BASE + 'Lessons-in-Electric-Circuits-Vol3-Semiconductors.pdf';
const DIGI = BASE + 'Lessons-in-Electric-Circuits-Vol4-Digital.pdf';
const UP2 = BASE + 'OpenStax-University-Physics-Vol2.pdf';
const anyEn = (name) => name.includes('English');

/** [query, truth path, truth pages, topic predicate, keyword paraphrase used by --multi] */
export const items = [
  ['State Kirchhoff voltage law for a series circuit loop', DC, [189, 190, 191], anyEn, 'KVL series circuit loop'],
  ['How do you find the Thevenin equivalent circuit of a network', DC, [379, 380, 381, 382], anyEn, 'Thevenin equivalent circuit'],
  ['Norton theorem convert a circuit into a current source', DC, [383, 384, 385], anyEn, 'Norton theorem current source'],
  ['How does the superposition theorem handle circuits with multiple sources', DC, [374, 375, 376], anyEn, 'superposition theorem multiple sources'],
  ['Voltage divider circuit formula for the drop across each resistor', DC, [183, 184, 185], anyEn, 'voltage divider formula'],
  ['Capacitive reactance formula and how it changes with frequency', AC, [94, 95, 96, 97], anyEn, 'capacitive reactance frequency formula'],
  ['Calculate the resonant frequency of an LC circuit', AC, [135, 136, 137], anyEn, 'LC resonant frequency'],
  ['Transformer turns ratio primary secondary voltage and current', AC, [244, 245, 246], anyEn, 'transformer turns ratio'],
  ['How does a common-emitter amplifier produce voltage gain', SEMI, [198, 199, 200], anyEn, 'common emitter voltage gain'],
  ['Zener diode reverse breakdown voltage heavy doping', SEMI, [69, 70, 71], anyEn, 'zener breakdown heavy doping'],
  ['Voltage divider bias circuit for a bipolar transistor', SEMI, [239, 240, 241, 244, 245, 246, 247, 248], anyEn, 'voltage divider bias transistor'],
  ['DeMorgan theorem breaking a long bar in Boolean expressions', DIGI, [202, 203, 204, 205], anyEn, 'DeMorgan theorem Boolean'],
  ['Karnaugh map simplification of a Boolean expression', DIGI, [248, 249, 250, 252], anyEn, 'Karnaugh map simplification'],
  ['J-K flip flop truth table and toggle behavior', DIGI, [324, 325, 326], anyEn, 'JK flip flop truth table'],
  ['Gauss law electric flux through a closed surface', UP2, [242, 243, 244, 250, 251, 252, 253], anyEn, 'Gauss law electric flux'],
  ['RC circuit time constant charge and discharge', UP2, [467, 468, 469, 477], anyEn, 'RC time constant'],
  ['Magnetic force on a moving charge right hand rule', UP2, [493, 494, 495], anyEn, 'magnetic force moving charge'],
];
