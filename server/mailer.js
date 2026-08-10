// SMTP mailer (MXroute or any standard SMTP provider). If SMTP isn't
// configured (local dev, or you haven't set it up yet), emails are logged to
// the console instead of thrown as errors -- lets everything else keep
// working while you sort out SMTP credentials.

const nodemailer = require('nodemailer');

const SMTP_HOST = process.env.SMTP_HOST || '';
const SMTP_PORT = Number(process.env.SMTP_PORT || 465);
const SMTP_SECURE = process.env.SMTP_SECURE !== 'false'; // true unless explicitly disabled
const SMTP_USER = process.env.SMTP_USER || '';
const SMTP_PASS = process.env.SMTP_PASS || '';
const MAIL_FROM = process.env.MAIL_FROM || SMTP_USER || 'no-reply@localhost';

const configured = Boolean(SMTP_HOST && SMTP_USER && SMTP_PASS);

const transporter = configured
  ? nodemailer.createTransport({
      host: SMTP_HOST,
      port: SMTP_PORT,
      secure: SMTP_SECURE,
      auth: { user: SMTP_USER, pass: SMTP_PASS },
    })
  : null;

async function sendMail({ to, subject, text, html }) {
  if (!transporter) {
    console.warn(`[mailer] SMTP not configured -- would have sent to ${to}: ${subject}\n${text}`);
    return { sent: false };
  }
  await transporter.sendMail({ from: MAIL_FROM, to, subject, text, html });
  return { sent: true };
}

function sendVerificationEmail(to, verifyUrl) {
  return sendMail({
    to,
    subject: 'Verify your River Clearance account',
    text: `Confirm your email to finish setting up your account:\n\n${verifyUrl}\n\nThis link expires in 24 hours. If you didn't sign up, ignore this email.`,
    html: `<p>Confirm your email to finish setting up your account:</p><p><a href="${verifyUrl}">${verifyUrl}</a></p><p>This link expires in 24 hours. If you didn't sign up, ignore this email.</p>`,
  });
}

function sendPasswordResetEmail(to, resetUrl) {
  return sendMail({
    to,
    subject: 'Reset your River Clearance password',
    text: `Reset your password here:\n\n${resetUrl}\n\nThis link expires in 1 hour. If you didn't request this, ignore this email -- your password won't change.`,
    html: `<p>Reset your password here:</p><p><a href="${resetUrl}">${resetUrl}</a></p><p>This link expires in 1 hour. If you didn't request this, ignore this email -- your password won't change.</p>`,
  });
}

module.exports = { sendMail, sendVerificationEmail, sendPasswordResetEmail, mailerConfigured: configured };
