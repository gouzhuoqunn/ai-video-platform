const MINOR_TERMS = /\b(child|children|kid|kids|minor|underage|teenager|schoolgirl|schoolboy)\b|儿童|小孩|未成年|幼女|幼男|学生妹/i;
const SEXUAL_TERMS = /\b(sex|sexual|nude|naked|porn|explicit|erotic)\b|性行为|色情|裸露|裸体|成人内容/i;
const NON_CONSENSUAL_TERMS = /\b(rape|raped|non[- ]?consensual|forced sex|sexual assault)\b|强奸|性侵|非自愿|强迫性行为/i;

export function validateProductionPrompt(prompt: string) {
  const normalized = prompt.normalize("NFKC").trim();
  if (MINOR_TERMS.test(normalized) && SEXUAL_TERMS.test(normalized)) {
    return { allowed: false, code: "minor_sexual_content", reason: "提示词不能包含涉及未成年人的性内容。" };
  }
  if (NON_CONSENSUAL_TERMS.test(normalized)) {
    return { allowed: false, code: "non_consensual_sexual_content", reason: "提示词不能包含非自愿性行为或性侵内容。" };
  }
  return { allowed: true, code: null, reason: null };
}
