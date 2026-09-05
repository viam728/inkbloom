/**
 * 阿拉伯数字 → 中文数字（大纲顺序标签「第N章/第X幕」用）。
 * 覆盖 1-9999 的简式读法（十/百/千位级），超出按数字回退。
 */
const DIGITS = ['零', '一', '二', '三', '四', '五', '六', '七', '八', '九'];

export function toChineseNumeral(n: number): string {
  if (!Number.isInteger(n) || n <= 0 || n > 9999) return String(n);
  if (n < 10) return DIGITS[n];
  if (n < 20) return n === 10 ? '十' : `十${DIGITS[n % 10]}`;
  if (n < 100) {
    const tens = Math.floor(n / 10);
    const ones = n % 10;
    return `${DIGITS[tens]}十${ones ? DIGITS[ones] : ''}`;
  }
  if (n < 1000) {
    const hundreds = Math.floor(n / 100);
    const rest = n % 100;
    if (rest === 0) return `${DIGITS[hundreds]}百`;
    if (rest < 10) return `${DIGITS[hundreds]}百零${DIGITS[rest]}`;
    return `${DIGITS[hundreds]}百${toChineseNumeral(rest)}`;
  }
  const thousands = Math.floor(n / 1000);
  const rest = n % 1000;
  if (rest === 0) return `${DIGITS[thousands]}千`;
  if (rest < 100) return `${DIGITS[thousands]}千零${toChineseNumeral(rest)}`;
  return `${DIGITS[thousands]}千${toChineseNumeral(rest)}`;
}
