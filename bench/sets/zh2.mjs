/** 12 Chinese questions added in s1, drawn from books the original zh set never touched. truth pages are 1-based chunk pages. */
const ADI = '学习/砖块/参考书籍/ADI-新概念模拟电路.pdf';
const TONG = '项目/砖块/7-模拟电子技术基础（第五版）高清版- 清华大学电子学教研组编、童诗白、华成英.pdf';
const KANG = '项目/砖块/12-电子技术基础.模拟部分.(康华光.第5版).pdf';
const TR1 = '项目/砖块/4-[晶体管电路设计(上)].铃木雅臣.2004年9月第一版.pdf';
const HSD = '学习/砖块/参考书籍/高速数字设计.pdf';

const has = (needle) => (name) => name.includes(needle);
const anyOf = (...needles) => (name) => needles.some((needle) => name.includes(needle));
const ANALOG = anyOf('ADI-新概念模拟电路', '7-模拟电子技术基础', '12-电子技术基础', '4-[晶体管电路设计', '高速数字设计');

/** [query, truth path, truth pages, topic predicate, English paraphrase, answer terms] */
export const items = [
  ['仪表放大器为什么适合直接接传感器前端', ADI, [292, 293, 294], ANALOG, 'instrumentation amplifier sensor front end', ['共模抑制', '高输入电阻']],
  ['反相放大电路里输入失调电压被放大多少倍', ADI, [342, 343], ANALOG, 'input offset voltage noise gain inverting amplifier', ['噪声增益']],
  ['热电偶为什么适合测量上千摄氏度的高温', ADI, [862, 863, 864], ANALOG, 'thermocouple high temperature measurement principle', ['两种不同材料', '单点接触']],
  ['二阶低通滤波器的 Q 值不同会造成什么差别', ADI, [453, 454, 455], ANALOG, 'second order low pass filter Q factor Butterworth Chebyshev', ['巴特沃斯', '切比雪夫']],
  ['直接耦合多级放大电路为什么要把 NPN 和 PNP 管混合使用', TONG, [147, 148], ANALOG, 'direct coupled multistage amplifier NPN PNP mix', ['直接耦合', 'PNP']],
  ['共模抑制比 KCMR 怎么定义', KANG, [283, 284, 285], ANALOG, 'common mode rejection ratio definition', ['差模', '共模']],
  ['运放的虚短和虚断是怎么来的', KANG, [62, 63], ANALOG, 'virtual short virtual open op amp deep negative feedback', ['深度负反馈', '虚短']],
  ['射极跟随器用恒流源做负载有什么好处', TR1, [76], ANALOG, 'emitter follower constant current load', ['恒流源']],
  ['地弹是怎么产生的、会影响什么', HSD, [63, 64, 65], ANALOG, 'ground bounce cause effect receiver', ['地弹']],
  ['眼图为什么能用来测量抖动', HSD, [103, 104, 105], ANALOG, 'eye diagram jitter measurement', ['眼图', '抖动']],
  ['电流镜做恒流源负载有什么作用', ADI, [170, 171, 172], ANALOG, 'current mirror constant current load', ['恒流源', '电流镜']],
  ['ADC 采样保持电路前串联电阻 RISO 为什么不能太大', ADI, [871, 874, 875], ANALOG, 'ADC sampling hold RISO error', ['采样保持', 'RISO']],
];
