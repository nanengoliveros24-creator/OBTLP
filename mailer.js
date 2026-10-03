/*
  Outbound email for sign-in verification codes (email OTP / MFA).

  Sends through Brevo's HTTPS email API instead of SMTP. Render's free
  instances can't reliably make outbound SMTP connections (Gmail SMTP on
  port 465/587), while an HTTPS API call always works. Brevo's free plan
  allows 300 emails/day and lets you send from a verified Gmail address,
  so the codes arrive in each user's Gmail inbox.

  Configuration (environment variables — set them in Render's dashboard,
  never commit them):
    BREVO_API_KEY   API key from Brevo → SMTP & API → API Keys
    MAIL_FROM       the sender address you verified in Brevo (e.g. your Gmail)
    MAIL_FROM_NAME  optional display name (default "OBTLP Generator System")

  Local development without Brevo:
    MFA_DEV_LOG=1   print the code in the server console instead of emailing
                    it (never set this on Render)
*/

const BREVO_URL = 'https://api.brevo.com/v3/smtp/email';

function brevoConfigured() {
  return !!(process.env.BREVO_API_KEY && process.env.MAIL_FROM);
}

function devLogMode() {
  return process.env.MFA_DEV_LOG === '1';
}

function escapeHtml(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[c]));
}

function otpEmail(name, code, minutes) {
  const subject = `${code} is your OBTLP sign-in code`;
  const text = [
    `Hi ${name || ''},`,
    '',
    `Your OBTLP Generator System verification code is: ${code}`,
    '',
    `It expires in ${minutes} minutes. If you did not try to sign in, you can ignore this email and consider changing your password.`,
    '',
    'Pamantasan ng Cabuyao (University of Cabuyao)'
  ].join('\n');
  const html = `
    <div style="font-family:Arial,Helvetica,sans-serif;max-width:480px;margin:0 auto;padding:24px;color:#1b2a22;">
      <p style="margin:0 0 4px;font-size:13px;color:#5b6b62;">Pamantasan ng Cabuyao · OBTLP Generator System</p>
      <h2 style="margin:0 0 16px;font-size:20px;">Your sign-in code</h2>
      <p style="margin:0 0 12px;">Hi ${escapeHtml(name || '')},</p>
      <p style="margin:0 0 16px;">Use this code to finish signing in:</p>
      <p style="font-size:32px;font-weight:bold;letter-spacing:8px;margin:0 0 16px;padding:12px 16px;background:#eef5f0;border-radius:8px;text-align:center;">${escapeHtml(code)}</p>
      <p style="margin:0 0 8px;font-size:13px;color:#5b6b62;">This code expires in ${minutes} minutes and can only be used once.</p>
      <p style="margin:0;font-size:13px;color:#5b6b62;">If you didn't try to sign in, ignore this email and consider changing your password.</p>
    </div>`;
  return { subject, text, html };
}

// Short security notices (account removed, password reset by an admin).
function noticeEmail(name, subject, lines) {
  const text = [`Hi ${name || ''},`, '', ...lines, '', 'Pamantasan ng Cabuyao (University of Cabuyao)'].join('\n');
  const html = `
    <div style="font-family:Arial,Helvetica,sans-serif;max-width:480px;margin:0 auto;padding:24px;color:#1b2a22;">
      <p style="margin:0 0 4px;font-size:13px;color:#5b6b62;">Pamantasan ng Cabuyao · OBTLP Generator System</p>
      <h2 style="margin:0 0 16px;font-size:20px;">${escapeHtml(subject)}</h2>
      <p style="margin:0 0 12px;">Hi ${escapeHtml(name || '')},</p>
      ${lines.map((l) => `<p style="margin:0 0 12px;">${escapeHtml(l)}</p>`).join('')}
    </div>`;
  return { subject, text, html };
}

async function sendNoticeEmail(to, name, subject, lines) {
  if (brevoConfigured()) {
    return brevoSend(to, name, noticeEmail(name, subject, lines));
  }
  if (devLogMode()) {
    console.log(`[mailer] (MFA_DEV_LOG) notice to ${to}: ${subject}`);
    return;
  }
}

async function brevoSend(to, name, { subject, text, html }) {
  const res = await fetch(BREVO_URL, {
    method: 'POST',
    headers: {
      'api-key': process.env.BREVO_API_KEY,
      'content-type': 'application/json',
      accept: 'application/json'
    },
    body: JSON.stringify({
      sender: { email: process.env.MAIL_FROM, name: process.env.MAIL_FROM_NAME || 'OBTLP Generator System' },
      to: [{ email: to, name: name || to }],
      subject,
      textContent: text,
      htmlContent: html
    })
  });
  if (!res.ok) {
    let detail = '';
    try { detail = await res.text(); } catch (e) { /* ignore */ }
    console.error(`[mailer] Brevo rejected the email (${res.status}): ${detail}`);
    throw { status: 502, message: 'We could not send the email right now. Please try again in a moment.' };
  }
}

async function sendOtpEmail(to, name, code, minutes) {
  if (brevoConfigured()) {
    const { subject, text, html } = otpEmail(name, code, minutes);
    const res = await fetch(BREVO_URL, {
      method: 'POST',
      headers: {
        'api-key': process.env.BREVO_API_KEY,
        'content-type': 'application/json',
        accept: 'application/json'
      },
      body: JSON.stringify({
        sender: { email: process.env.MAIL_FROM, name: process.env.MAIL_FROM_NAME || 'OBTLP Generator System' },
        to: [{ email: to, name: name || to }],
        subject,
        textContent: text,
        htmlContent: html
      })
    });
    if (!res.ok) {
      let detail = '';
      try { detail = await res.text(); } catch (e) { /* ignore */ }
      console.error(`[mailer] Brevo rejected the email (${res.status}): ${detail}`);
      throw { status: 502, message: 'We could not send the verification email right now. Please try again in a moment.' };
    }
    return;
  }
  if (devLogMode()) {
    console.log(`[mailer] (MFA_DEV_LOG) sign-in code for ${to}: ${code}`);
    return;
  }
  throw { status: 503, message: 'Email delivery is not configured on the server.' };
}

module.exports = { sendOtpEmail, sendNoticeEmail, brevoConfigured, devLogMode };
