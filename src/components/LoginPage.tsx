import React, { useEffect, useState } from 'react';
import {
  ArrowRight,
  CheckCircle2,
  Code2,
  Download,
  FileSpreadsheet,
  KeyRound,
  Lock,
  Scale,
  ShieldCheck,
} from 'lucide-react';
import { signInWithPopup } from 'firebase/auth';
import { apiFetch, setStoredToken } from '../lib/api';
import { auth, googleAuthProvider } from '../lib/firebase';
import type { AuthUser } from '../types/compliance';

interface LoginPageProps {
  onLoginSuccess: (user: AuthUser) => void;
}

export default function LoginPage({ onLoginSuccess }: LoginPageProps) {
  const [statusLoading, setStatusLoading] = useState(true);
  const [adminConfigured, setAdminConfigured] = useState(true);
  const [loginId, setLoginId] = useState('');
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [fullName, setFullName] = useState('DPCO Administrator');
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    let active = true;
    apiFetch<{ adminConfigured: boolean }>('/api/auth/status')
      .then((res) => {
        if (!active) return;
        setAdminConfigured(Boolean(res.adminConfigured));
      })
      .catch(() => {
        if (active) setAdminConfigured(true);
      })
      .finally(() => {
        if (active) setStatusLoading(false);
      });
    return () => {
      active = false;
    };
  }, []);

  async function handleGoogleSignIn() {
    setError(null);
    setSubmitting(true);
    try {
      const cred = await signInWithPopup(auth, googleAuthProvider);
      const idToken = await cred.user.getIdToken();
      setStoredToken(idToken);
      const me = await apiFetch<{ user: AuthUser }>('/api/auth/me');
      onLoginSuccess(me.user);
    } catch (err) {
      setStoredToken(null);
      const msg = err instanceof Error ? err.message : 'Google Sign-In failed.';
      if (!msg.includes('popup-closed-by-user')) {
        setError(msg);
      }
    } finally {
      setSubmitting(false);
    }
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      const data = await apiFetch<{ token: string; user: AuthUser }>('/api/auth/login', {
        method: 'POST',
        body: JSON.stringify({ loginId, password }),
      });
      setStoredToken(data.token);
      onLoginSuccess(data.user);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unable to sign in.');
    } finally {
      setSubmitting(false);
    }
  }

  async function handleSetupAdmin(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    if (password.trim().length < 8) {
      setError('Administrator password must be at least 8 characters long.');
      return;
    }
    if (password !== confirmPassword) {
      setError('Passwords do not match.');
      return;
    }
    setSubmitting(true);
    try {
      const data = await apiFetch<{ token: string; user: AuthUser }>('/api/auth/setup-admin', {
        method: 'POST',
        body: JSON.stringify({
          loginId: loginId.trim(),
          password,
          fullName: fullName.trim() || 'DPCO Administrator',
        }),
      });
      setStoredToken(data.token);
      onLoginSuccess(data.user);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unable to configure administrator.');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="min-h-screen bg-[#F7F8FC] text-slate-900 flex flex-col justify-between">
      {/* Top Bar */}
      <header className="border-b border-indigo-100 bg-white/95 backdrop-blur-sm">
        <div className="max-w-7xl mx-auto px-6 py-4 flex items-center justify-between gap-8">
          <span className="font-display text-lg font-bold tracking-tight text-indigo-950 whitespace-nowrap shrink-0">
            DPCO Compliance
          </span>
          <nav className="hidden md:flex items-center gap-6 text-sm font-medium text-slate-600">
            <a href="#overview" className="hover:text-slate-900 transition-colors whitespace-nowrap shrink-0">
              Overview
            </a>
            <a href="#modules" className="hover:text-slate-900 transition-colors whitespace-nowrap shrink-0">
              Regulatory Modules
            </a>
            <a href="/api/export/standalone-html/preview" target="_blank" rel="noreferrer" className="hover:text-slate-900 transition-colors whitespace-nowrap shrink-0">
              HTML Outlook
            </a>
          </nav>
          <div className="flex items-center gap-3 shrink-0">
            <a
              href="/api/export/standalone-html"
              className="inline-flex items-center gap-2 px-4 py-2 text-xs font-semibold text-slate-700 bg-white border border-slate-300 rounded-lg hover:bg-slate-50 transition-colors whitespace-nowrap shrink-0"
            >
              <Download className="w-3.5 h-3.5" />
              Download HTML
            </a>
          </div>
        </div>
      </header>

      {/* Main Content */}
      <main id="overview" className="max-w-7xl w-full mx-auto px-6 py-12 lg:py-16">
        <div className="grid grid-cols-1 lg:grid-cols-12 gap-10 items-stretch">
          {/* Left Column: Brief + 3 Feature Boxes */}
          <div className="lg:col-span-7 flex flex-col justify-between gap-8">
            <div>
              <p className="text-xs font-semibold tracking-wide text-blue-800 mb-3">
                NPPA Regulatory Intelligence · DPCO 2013 &amp; NLEM 2022
              </p>
              <h1 className="font-display text-4xl sm:text-5xl font-bold tracking-tight text-slate-900 text-balance mb-5">
                DPCO Compliance
              </h1>
              <p className="text-base text-slate-600 leading-relaxed max-w-2xl">
                Centralized pharmaceutical pricing compliance platform built for Indian regulatory affairs teams.
                Automated daily 10:00 AM IST monitoring of NPPA circulars, Authority meeting minutes (2026–2027),
                and Multidisciplinary Expert Committee notes—paired with GST-inclusive pack MRP conversion,
                Form 1A retail price retention logs, and NLEM 2022 Form I applicability screening.
              </p>
            </div>

            {/* 3 Highlight Boxes: Ceiling Price, Retail Price, Form I Updates */}
            <div id="modules" className="grid grid-cols-1 sm:grid-cols-3 gap-4">
              <div className="bg-[#EEF2FF] border border-indigo-200/80 rounded-xl p-5 flex flex-col justify-between">
                <div>
                  <div className="w-9 h-9 rounded-lg bg-white text-indigo-700 border border-indigo-100 flex items-center justify-center mb-4">
                    <Scale className="w-4 h-4" />
                  </div>
                  <h2 className="font-display text-base font-semibold text-indigo-950 mb-2">
                    Ceiling Price
                  </h2>
                  <p className="text-sm text-slate-700 leading-relaxed">
                    Tracks scheduled formulation notifications by composition, strength, and dosage format with instant MRP per pack conversion using Ceiling Price + (Ceiling Price × GST%).
                  </p>
                </div>
                <p className="mt-4 pt-3 border-t border-indigo-200/60 text-xs font-mono text-indigo-900 tabular-nums">
                  Daily 10:00 AM IST Sync
                </p>
              </div>

              <div className="bg-[#ECFDF5] border border-emerald-200/80 rounded-xl p-5 flex flex-col justify-between">
                <div>
                  <div className="w-9 h-9 rounded-lg bg-white text-emerald-700 border border-emerald-100 flex items-center justify-center mb-4">
                    <FileSpreadsheet className="w-4 h-4" />
                  </div>
                  <h2 className="font-display text-base font-semibold text-emerald-950 mb-2">
                    Retail Price
                  </h2>
                  <p className="text-sm text-slate-700 leading-relaxed">
                    Maintains post-16 July 2026 retail price circulars (Notification No., Date, Formulation, Price) as a Form 1A ready launch list with a 1-year rolling log.
                  </p>
                </div>
                <p className="mt-4 pt-3 border-t border-emerald-200/60 text-xs font-mono text-emerald-900 tabular-nums">
                  Post 16 Jul 2026 · 1-Yr Log
                </p>
              </div>

              <div className="bg-[#FFF1F2] border border-rose-200/80 rounded-xl p-5 flex flex-col justify-between">
                <div>
                  <div className="w-9 h-9 rounded-lg bg-white text-rose-700 border border-rose-100 flex items-center justify-center mb-4">
                    <ShieldCheck className="w-4 h-4" />
                  </div>
                  <h2 className="font-display text-base font-semibold text-rose-950 mb-2">
                    Form I Updates
                  </h2>
                  <p className="text-sm text-slate-700 leading-relaxed">
                    Screens new product compositions against NLEM 2022 and cross-checks your existing manufactured portfolio to determine Form I applicability.
                  </p>
                </div>
                <p className="mt-4 pt-3 border-t border-rose-200/60 text-xs font-mono text-rose-900 tabular-nums">
                  NLEM 2022 · Existing Mfg.
                </p>
              </div>
            </div>

            <div className="flex flex-wrap items-center gap-x-6 gap-y-2 text-xs text-slate-500">
              <span className="inline-flex items-center gap-1.5">
                <CheckCircle2 className="w-3.5 h-3.5 text-emerald-600" />
                NPPA Circulars (view_more?id=4)
              </span>
              <span aria-hidden="true">·</span>
              <span>Authority Minutes (year2026-2027)</span>
              <span aria-hidden="true">·</span>
              <span>Expert Committee Minutes</span>
            </div>
          </div>

          {/* Right Column: Login / First-Run Admin Setup Card */}
          <div className="lg:col-span-5 flex flex-col justify-center">
            <div className="bg-white border border-indigo-100 rounded-xl p-7 sm:p-8">
              <div className="flex items-center justify-between gap-4 mb-6">
                <div>
                  <h2 className="font-display text-xl font-bold text-indigo-950">
                    {adminConfigured ? 'Authorized Sign In' : 'Initial Administrator Setup'}
                  </h2>
                  <p className="text-sm text-slate-500 mt-1">
                    {adminConfigured
                      ? 'Enter your approved Login ID and password to access the compliance workspace.'
                      : 'No administrator account is configured yet. Create the initial administrator credentials to lock and enter the workspace.'}
                  </p>
                </div>
                <div className="w-10 h-10 rounded-lg bg-[#EEF2FF] text-indigo-700 flex items-center justify-center shrink-0">
                  {adminConfigured ? <Lock className="w-4 h-4" /> : <KeyRound className="w-4 h-4" />}
                </div>
              </div>

              {error && (
                <div
                  role="alert"
                  className="mb-5 p-3.5 rounded-lg bg-rose-50 border border-rose-200 text-sm text-rose-800"
                >
                  {error}
                </div>
              )}

              {statusLoading ? (
                <div className="py-8 text-center text-sm text-slate-500">
                  Checking workspace authentication status…
                </div>
              ) : adminConfigured ? (
                <div className="space-y-4">
                  <button
                    type="button"
                    onClick={handleGoogleSignIn}
                    disabled={submitting}
                    className="w-full inline-flex items-center justify-center gap-2.5 px-4 py-2.5 text-sm font-semibold text-slate-800 bg-white border border-slate-300 rounded-lg hover:bg-slate-50 disabled:opacity-60 transition-colors cursor-pointer"
                  >
                    <svg className="w-4 h-4 shrink-0" viewBox="0 0 24 24" aria-hidden="true">
                      <path
                        fill="#4285F4"
                        d="M23.745 12.27c0-.7-.06-1.4-.19-2.07H12v4.51h6.6c-.29 1.52-1.14 2.82-2.4 3.68v3.05h3.88c2.27-2.09 3.665-5.17 3.665-9.17Z"
                      />
                      <path
                        fill="#34A853"
                        d="M12 24c3.24 0 5.95-1.08 7.93-2.91l-3.88-3.05c-1.08.72-2.45 1.16-4.05 1.16-3.12 0-5.77-2.11-6.72-4.96H1.29v3.14C3.26 21.3 7.31 24 12 24Z"
                      />
                      <path
                        fill="#FBBC05"
                        d="M5.28 14.24c-.24-.72-.38-1.49-.38-2.24s.14-1.52.38-2.24V6.62H1.29C.47 8.24 0 10.06 0 12s.47 3.76 1.29 5.38l3.99-3.14Z"
                      />
                      <path
                        fill="#EA4335"
                        d="M12 4.75c1.77 0 3.35.61 4.6 1.8l3.42-3.42C17.95 1.19 15.24 0 12 0 7.31 0 3.26 2.7 1.29 6.62l3.99 3.14c.95-2.85 3.6-4.96 6.72-4.96Z"
                      />
                    </svg>
                    Continue with Google
                  </button>

                  <div className="relative flex items-center py-1">
                    <div className="flex-grow border-t border-slate-200" />
                    <span className="shrink mx-3 text-[11px] uppercase tracking-wider text-slate-400 font-medium">
                      or Login ID
                    </span>
                    <div className="flex-grow border-t border-slate-200" />
                  </div>

                  <form onSubmit={handleSubmit} className="space-y-4">
                    <div>
                      <label htmlFor="loginId" className="block text-sm font-medium text-slate-700 mb-1.5">
                        Login ID
                      </label>
                      <input
                        id="loginId"
                        type="text"
                        autoComplete="username"
                        required
                        value={loginId}
                        onChange={(e) => setLoginId(e.target.value)}
                        placeholder="Enter your Login ID"
                        className="w-full px-3.5 py-2.5 text-sm bg-white border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-indigo-600 focus:border-indigo-600"
                      />
                    </div>

                    <div>
                      <label htmlFor="password" className="block text-sm font-medium text-slate-700 mb-1.5">
                        Password
                      </label>
                      <input
                        id="password"
                        type="password"
                        autoComplete="current-password"
                        required
                        value={password}
                        onChange={(e) => setPassword(e.target.value)}
                        placeholder="Enter password"
                        className="w-full px-3.5 py-2.5 text-sm bg-white border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-indigo-600 focus:border-indigo-600"
                      />
                    </div>

                    <button
                      type="submit"
                      disabled={submitting}
                      className="w-full inline-flex items-center justify-center gap-2 px-4 py-2.5 text-sm font-semibold text-white bg-indigo-700 rounded-lg hover:bg-indigo-800 disabled:opacity-60 transition-colors cursor-pointer"
                    >
                      {submitting ? 'Verifying Credentials…' : 'Sign In with Login ID'}
                      <ArrowRight className="w-4 h-4" />
                    </button>
                  </form>
                </div>
              ) : (
                <form onSubmit={handleSetupAdmin} className="space-y-4">
                  <div>
                    <label htmlFor="setupFullName" className="block text-sm font-medium text-slate-700 mb-1.5">
                      Administrator Name
                    </label>
                    <input
                      id="setupFullName"
                      type="text"
                      required
                      value={fullName}
                      onChange={(e) => setFullName(e.target.value)}
                      placeholder="DPCO Administrator"
                      className="w-full px-3.5 py-2.5 text-sm bg-white border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-indigo-600 focus:border-indigo-600"
                    />
                  </div>

                  <div>
                    <label htmlFor="setupLoginId" className="block text-sm font-medium text-slate-700 mb-1.5">
                      Admin Login ID
                    </label>
                    <input
                      id="setupLoginId"
                      type="text"
                      autoComplete="username"
                      required
                      minLength={3}
                      value={loginId}
                      onChange={(e) => setLoginId(e.target.value)}
                      placeholder="Choose an admin Login ID (min 3 chars)"
                      className="w-full px-3.5 py-2.5 text-sm bg-white border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-indigo-600 focus:border-indigo-600"
                    />
                  </div>

                  <div>
                    <label htmlFor="setupPassword" className="block text-sm font-medium text-slate-700 mb-1.5">
                      Admin Password
                    </label>
                    <input
                      id="setupPassword"
                      type="password"
                      autoComplete="new-password"
                      required
                      minLength={8}
                      value={password}
                      onChange={(e) => setPassword(e.target.value)}
                      placeholder="Minimum 8 characters"
                      className="w-full px-3.5 py-2.5 text-sm bg-white border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-indigo-600 focus:border-indigo-600"
                    />
                  </div>

                  <div>
                    <label htmlFor="setupConfirmPassword" className="block text-sm font-medium text-slate-700 mb-1.5">
                      Confirm Password
                    </label>
                    <input
                      id="setupConfirmPassword"
                      type="password"
                      autoComplete="new-password"
                      required
                      minLength={8}
                      value={confirmPassword}
                      onChange={(e) => setConfirmPassword(e.target.value)}
                      placeholder="Re-enter admin password"
                      className="w-full px-3.5 py-2.5 text-sm bg-white border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-indigo-600 focus:border-indigo-600"
                    />
                  </div>

                  <button
                    type="submit"
                    disabled={submitting}
                    className="w-full inline-flex items-center justify-center gap-2 px-4 py-2.5 text-sm font-semibold text-white bg-indigo-700 rounded-lg hover:bg-indigo-800 disabled:opacity-60 transition-colors cursor-pointer"
                  >
                    {submitting ? 'Configuring Administrator…' : 'Create Admin & Enter Workspace'}
                    <ArrowRight className="w-4 h-4" />
                  </button>
                </form>
              )}

              <div className="mt-6 pt-4 border-t border-slate-200 text-xs text-slate-500 leading-relaxed">
                {adminConfigured
                  ? 'Access is restricted to administrator-provisioned Login IDs. Additional team accounts can be managed under Admin Access.'
                  : 'For automated deployments, initial administrator credentials can also be provisioned via your server environment settings.'}
              </div>
            </div>
          </div>
        </div>
      </main>

      {/* Footer */}
      <footer className="border-t border-slate-200 bg-white">
        <div className="max-w-7xl mx-auto px-6 py-4 flex flex-col sm:flex-row items-center justify-between gap-2 text-xs text-slate-500">
          <span>DPCO Compliance Portal · Drugs (Prices Control) Order, 2013 &amp; NLEM 2022</span>
          <a
            href="/api/export/standalone-html/preview"
            target="_blank"
            rel="noreferrer"
            className="inline-flex items-center gap-1.5 text-slate-600 hover:text-slate-900"
          >
            <Code2 className="w-3.5 h-3.5" />
            View Standalone HTML Outlook
          </a>
        </div>
      </footer>
    </div>
  );
}
