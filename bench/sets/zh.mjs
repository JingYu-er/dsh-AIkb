/** 26 Chinese questions over the mixed hardware/embedded library. truth pages are 0-based PDF pages. */
const STM = '学习/砖块/参考手册/ST-STM32F10xxx 基于 Arm® 内核的 32 位高级 MCU.pdf';
const MSP430 = '学习/砖块/用户手册/MSP430FR4xx and MSP430FR2xx family.pdf';
const MSPM0 = '学习/砖块/数据手册/TI-MSPM0 L-Series 32MHz Microcontrollers.pdf';
const ADI = '学习/砖块/参考书籍/ADI-新概念模拟电路.pdf';
const NOTES = '学习/硬件/模电/模拟电子技术基础(上交大郑益慧老师45集全)课堂笔记.pdf';
const FPE = '学习/砖块/参考书籍/Fundamentals of Power Electronics 3rd Edition.pdf';
const ADA4505 = '学习/砖块/数据手册/ADI-ADA4505.pdf';
const ICL7660 = '学习/砖块/数据手册/ADI-ICL7660.pdf';

const has = (needle) => (name) => name.includes(needle);
const anyOf = (...needles) => (name) => needles.some((needle) => name.includes(needle));
const ANALOG = anyOf('ADI-新概念模拟电路', '模拟电子技术基础', '14 电子技术基础', '3-晶体管', '0-教材 徐琳大纲', '电子电路基础', '电子电路原理', 'OP放大电路设计', '晶体管电路设计', '模拟集成电路', '电路_邱关源', '电子学');

/** [query, truth path, truth pages, topic predicate, English paraphrase used by --multi] */
export const items = [
  ['STM32F10xxx 的 CRC 计算单元怎么用', STM, [63, 64, 65, 66], has('STM32'), 'STM32F10x CRC calculation unit registers'],
  ['STM32 低功耗模式 Sleep Stop Standby 有什么区别', STM, [72, 77, 85], has('STM32'), 'STM32 low power modes Sleep Stop Standby differences'],
  ['USART 波特率寄存器 BRR 如何计算波特率', STM, [788, 789, 792, 795], has('STM32'), 'USART baud rate register BRR calculation'],
  ['SysTick 校准值有什么用', STM, [197], has('STM32'), 'SysTick calibration value purpose'],
  ['MSP430 设备描述符表 Device Descriptor Table 是什么', MSP430, [57, 58, 59, 60], has('MSP430'), 'MSP430 device descriptor table'],
  ['MSP430 的 RST/NMI 复位引脚怎么配置', MSP430, [43], has('MSP430'), 'MSP430 RST NMI reset pin configuration'],
  ['MSPM0 启动配置 boot configuration', MSPM0, [18, 20, 23, 24], has('MSPM0'), 'MSPM0 boot configuration'],
  ['MSPM0 时钟模块 CKM 的时钟源', MSPM0, [140, 157], has('MSPM0'), 'MSPM0 clock module CKM clock sources'],
  ['共射放大电路的静态工作点', ADI, [65, 66, 70, 71, 72, 73], ANALOG, 'common emitter amplifier quiescent operating point'],
  ['差分放大电路的共模抑制', ADI, [369, 370, 372, 380], ANALOG, 'differential amplifier common mode rejection'],
  ['差分放大电路的分析', NOTES, [46, 47, 48, 54, 57], ANALOG, 'differential amplifier analysis'],
  ['负反馈对放大电路的影响', NOTES, [85, 88, 90, 91, 92, 93], ANALOG, 'negative feedback effects on amplifier'],
  ['积分电路的原理', NOTES, [127, 161, 167], ANALOG, 'integrator circuit principle'],
  ['small ripple approximation 小纹波近似', FPE, [268], has('Fundamentals of Power'), 'small ripple approximation'],
  ['Cuk converter 的工作原理', FPE, [46, 47, 48, 49, 50], has('Fundamentals of Power'), 'Cuk converter operating principle'],
  ['STM32 的 VBAT 引脚和电池备份域有什么作用', STM, [69], has('STM32'), 'STM32 VBAT pin battery backup domain'],
  ['STM32 RTC 时钟源 RTCSEL 可以选哪些', STM, [77, 118, 151, 483], has('STM32'), 'STM32 RTC clock source RTCSEL options'],
  ['MSP430 看门狗定时器 WDT_A 的时钟源有哪些', MSP430, [360, 361, 362, 364], has('MSP430'), 'MSP430 watchdog timer WDT_A clock sources'],
  ['MSP430 的 eUSCI_A UART 模式怎么用', MSP430, [574, 575, 592, 593], has('MSP430'), 'MSP430 eUSCI_A UART mode'],
  ['ADA4505 的 rail-to-rail 输入输出和零交越失真是怎么回事', ADA4505, [14, 15], has('ADA4505'), 'ADA4505 rail-to-rail input output zero crossover distortion'],
  ['ADA4505 失调电压 offset voltage 最大是多少', ADA4505, [1, 3, 6], has('ADA4505'), 'ADA4505 offset voltage maximum'],
  ['ICL7660 的振荡器频率 OSC 引脚接电容有什么影响', ICL7660, [12], has('ICL7660'), 'ICL7660 oscillator frequency OSC capacitor'],
  ['ICL7660 如何把正电压转换成负电压', ICL7660, [11], has('ICL7660'), 'ICL7660 positive to negative voltage converter'],
  ['current programmed control 电流编程控制是什么', FPE, [727, 729, 731], has('Fundamentals of Power'), 'current programmed control'],
  ['DCM 不连续导通模式的平均开关模型', FPE, [149, 150, 151, 152, 585, 586], has('Fundamentals of Power'), 'DCM discontinuous conduction mode average switch model'],
  ['放大电路的频率响应', NOTES, [58, 59], ANALOG, 'amplifier frequency response'],
];
