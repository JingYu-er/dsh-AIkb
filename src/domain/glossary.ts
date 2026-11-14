/**
 * Cross-language query expansion for electronics/embedded engineering.
 *
 * The corpus mixes Chinese textbooks with English datasheets and reference manuals,
 * so a Chinese question about an English manual shares almost no tokens with the page
 * that answers it. BM25 alone cannot bridge that gap. This table is intentionally
 * domain-specific and small:
 * one line per term a reader actually types.
 */
const TERMS: ReadonlyArray<readonly [string, string]> = [
  ['计算单元', 'calculation unit'],
  ['波特率', 'baud rate'],
  ['低功耗', 'low-power'],
  ['复位引脚', 'reset pin'],
  ['复位', 'reset'],
  ['时钟模块', 'clock module'],
  ['时钟源', 'clock source'],
  ['时钟', 'clock'],
  ['中断向量', 'interrupt vector'],
  ['中断', 'interrupt'],
  ['寄存器', 'register'],
  ['运算放大器', 'operational amplifier'],
  ['放大器', 'amplifier'],
  ['差分放大', 'differential amplifier'],
  ['共模抑制', 'common-mode rejection'],
  ['共模', 'common mode'],
  ['差模', 'differential mode'],
  ['静态工作点', 'quiescent operating point'],
  ['负反馈', 'negative feedback'],
  ['反馈', 'feedback'],
  ['积分电路', 'integrator circuit'],
  ['微分电路', 'differentiator circuit'],
  ['开关电源', 'switching power supply'],
  ['纹波', 'ripple'],
  ['小纹波近似', 'small ripple approximation'],
  ['占空比', 'duty cycle'],
  ['变压器', 'transformer'],
  ['电感', 'inductor'],
  ['电容', 'capacitor'],
  ['二极管', 'diode'],
  ['晶体管', 'transistor'],
  ['场效应管', 'MOSFET'],
  ['偏置电流', 'bias current'],
  ['偏置', 'bias'],
  ['增益带宽积', 'gain bandwidth product'],
  ['压摆率', 'slew rate'],
  ['失调电压', 'offset voltage'],
  ['上拉', 'pull-up'],
  ['下拉', 'pull-down'],
  ['启动配置', 'boot configuration'],
  ['设备描述符', 'device descriptor'],
  ['校准', 'calibration'],
  ['唤醒', 'wakeup'],
  ['看门狗', 'watchdog'],
  ['定时器', 'timer'],
  ['串口', 'UART'],
  ['天线', 'antenna'],
  ['阻抗匹配', 'impedance matching'],
  ['传输线', 'transmission line'],
  ['信号完整性', 'signal integrity'],
  ['电源完整性', 'power integrity'],
  ['冲激响应', 'impulse response'],
  ['阶跃响应', 'step response'],
  ['零输入响应', 'zero-input response'],
  ['零状态响应', 'zero-state response'],
  ['采样定理', 'sampling theorem'],
  ['模数转换', 'analog-to-digital converter'],
  ['数模转换', 'digital-to-analog converter'],
  ['噪声', 'noise'],
  ['增益', 'gain'],
  ['带宽', 'bandwidth'],
  ['频率响应', 'frequency response'],
  ['仿真', 'simulation'],
  ['封装', 'package'],
  ['引脚', 'pin'],
];

/** Extra search terms for a query, so a Chinese question can reach an English page. */
export function expandQuery(queryText: string): string[] {
  const lower = queryText.toLowerCase();
  const extra: string[] = [];
  for (const [chinese, english] of TERMS) {
    if (lower.includes(chinese)) extra.push(english);
  }
  return extra;
}
