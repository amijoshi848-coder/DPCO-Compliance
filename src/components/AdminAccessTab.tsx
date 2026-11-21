import React, { useEffect, useState } from 'react';
import {
  Code2,
  Download,
  KeyRound,
  Plus,
  RefreshCw,
  Trash2,
  UserCheck,
  UserX,
} from 'lucide-react';
import { apiFetch } from '../lib/api';
import type { AuthUser, SyncLogEntry } from '../types/compliance';

interface AdminAccessTabProps {
  currentUser: AuthUser;
  syncLogs: SyncLogEntry[];
  onTriggerSync: () => Promise<void>;
}

export default function AdminAccessTab({
  currentUser,
  syncLogs,
  onTriggerSync,
}: AdminAccessTabProps) {
  const [users, setUsers] = useState<AuthUser[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [syncing, setSyncing] = useState(false);

  // Add allowed ID form
  const [newUser, setNewUser] = useState({
    loginId: '',
    fullName: '',
    department: 'Regulatory Affairs',
    role: 'user' as 'admin' | 'user',
    password: '',
  });
  const [creating, setCreating] = useState(false);

  async function loadUsers() {
    setLoading(true);
    setError(null);
    try {
      const res = await apiFetch<{ users: AuthUser[] }>('/api/admin/users');
      setUsers(res.users);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unable to load users.');
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void loadUsers();
  }, []);

  async function handleAddUser(e: React.FormEvent) {
    e.preventDefault();
    setCreating(true);
    setError(null);
    try {
      await apiFetch('/api/admin/users', {
        method: 'POST',
        body: JSON.stringify(newUser),
      });
      setNewUser({
        loginId: '',
        fullName: '',
        department: 'Regulatory Affairs',
        role: 'user',
        password: '',
      });
      await loadUsers();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to create allowed Login ID.');
    } finally {
      setCreating(false);
    }
  }

  async function toggleActive(u: AuthUser) {
    setError(null);
    try {
      await apiFetch(`/api/admin/users/${u.id}`, {
        method: 'PUT',
        body: JSON.stringify({ active: !u.active }),
      });
      await loadUsers();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to update status.');
    }
  }

  async function toggleRole(u: AuthUser) {
    setError(null);
    try {
      await apiFetch(`/api/admin/users/${u.id}`, {
        method: 'PUT',
        body: JSON.stringify({ role: u.role === 'admin' ? 'user' : 'admin' }),
      });
      await loadUsers();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to change role.');
    }
  }

  async function deleteUser(u: AuthUser) {
    setError(null);
    try {
      await apiFetch(`/api/admin/users/${u.id}`, { method: 'DELETE' });
      await loadUsers();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to delete user.');
    }
  }

  async function runSync() {
    setSyncing(true);
    try {
      await onTriggerSync();
    } finally {
      setSyncing(false);
    }
  }

  return (
    <div className="space-y-8">
      {/* Allowed Login IDs Section */}
      <section className="bg-white border border-slate-200 rounded-xl p-6">
        <div className="pb-5 border-b border-slate-200">
          <h2 className="font-display text-lg font-semibold text-slate-900">
            Allowed Login IDs &amp; Access Control
          </h2>
          <p className="text-sm text-slate-600 mt-1">
            Add, activate, deactivate, or delete Login IDs permitted to sign in and use the DPCO Compliance tool. Only Admins can add/edit/delete regulatory master logs.
          </p>
        </div>

        {error && (
          <div className="mt-4 p-3 rounded-lg bg-red-50 border border-red-200 text-xs text-red-800">
            {error}
          </div>
        )}

        <form onSubmit={handleAddUser} className="mt-5 grid grid-cols-1 md:grid-cols-12 gap-3 items-end">
          <div className="md:col-span-2">
            <label className="block text-xs font-medium text-slate-600 mb-1">
              Allowed Login ID
            </label>
            <input
              type="text"
              required
              value={newUser.loginId}
              onChange={(e) => setNewUser({ ...newUser, loginId: e.target.value })}
              placeholder="e.g. ananya.ra"
              className="w-full px-3 py-2 text-sm border border-slate-300 rounded-lg font-mono"
            />
          </div>
          <div className="md:col-span-3">
            <label className="block text-xs font-medium text-slate-600 mb-1">Full Name</label>
            <input
              type="text"
              required
              value={newUser.fullName}
              onChange={(e) => setNewUser({ ...newUser, fullName: e.target.value })}
              placeholder="Ananya Sharma"
              className="w-full px-3 py-2 text-sm border border-slate-300 rounded-lg"
            />
          </div>
          <div className="md:col-span-2">
            <label className="block text-xs font-medium text-slate-600 mb-1">Department</label>
            <input
              type="text"
              value={newUser.department}
              onChange={(e) => setNewUser({ ...newUser, department: e.target.value })}
              className="w-full px-3 py-2 text-sm border border-slate-300 rounded-lg"
            />
          </div>
          <div className="md:col-span-2">
            <label className="block text-xs font-medium text-slate-600 mb-1">Role</label>
            <select
              value={newUser.role}
              onChange={(e) =>
                setNewUser({ ...newUser, role: e.target.value as 'admin' | 'user' })
              }
              className="w-full px-3 py-2 text-sm border border-slate-300 rounded-lg bg-white"
            >
              <option value="user">Standard User</option>
              <option value="admin">Admin (Full Edit/Delete)</option>
            </select>
          </div>
          <div className="md:col-span-2">
            <label className="block text-xs font-medium text-slate-600 mb-1">Password</label>
            <input
              type="password"
              required
              value={newUser.password}
              onChange={(e) => setNewUser({ ...newUser, password: e.target.value })}
              placeholder="Set password"
              className="w-full px-3 py-2 text-sm border border-slate-300 rounded-lg"
            />
          </div>
          <div className="md:col-span-1">
            <button
              type="submit"
              disabled={creating}
              className="w-full inline-flex items-center justify-center gap-1 px-3 py-2 text-xs font-semibold text-white bg-indigo-700 rounded-lg hover:bg-indigo-800 cursor-pointer"
            >
              <Plus className="w-4 h-4" />
              Add
            </button>
          </div>
        </form>

        <div className="mt-5 overflow-x-auto border border-indigo-100 rounded-lg">
          <table className="w-full text-left border-collapse">
            <thead>
              <tr className="bg-[#EEF2FF] border-b border-indigo-100 text-xs font-semibold text-indigo-950">
                <th className="py-3 px-4">Login ID</th>
                <th className="py-3 px-3">User &amp; Department</th>
                <th className="py-3 px-3">Role</th>
                <th className="py-3 px-3">Access Status</th>
                <th className="py-3 px-3">Last Login</th>
                <th className="py-3 px-4 text-right">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-200 text-sm">
              {loading ? (
                <tr>
                  <td colSpan={6} className="py-6 text-center text-slate-500">
                    Loading authorized users…
                  </td>
                </tr>
              ) : (
                users.map((u) => {
                  const isSelf = u.id === currentUser.id;
                  return (
                    <tr key={u.id} className="hover:bg-slate-50">
                      <td className="py-3 px-4 font-mono text-xs font-semibold text-slate-900">
                        {u.loginId}
                      </td>
                      <td className="py-3 px-3">
                        <div className="font-medium text-slate-900">{u.fullName}</div>
                        <div className="text-xs text-slate-500">{u.department}</div>
                      </td>
                      <td className="py-3 px-3 text-xs">
                        <button
                          type="button"
                          onClick={() => toggleRole(u)}
                          disabled={isSelf}
                          className="inline-flex items-center gap-1 text-slate-700 hover:text-blue-800 disabled:opacity-60 cursor-pointer"
                        >
                          <KeyRound className="w-3.5 h-3.5" />
                          {u.role === 'admin' ? 'Admin' : 'Standard User'}
                        </button>
                      </td>
                      <td className="py-3 px-3 text-xs font-medium">
                        {u.active ? (
                          <span className="text-emerald-700">Allowed / Active</span>
                        ) : (
                          <span className="text-red-700">Disabled</span>
                        )}
                      </td>
                      <td className="py-3 px-3 font-mono text-xs text-slate-500 tabular-nums">
                        {u.lastLoginAt ? new Date(u.lastLoginAt).toLocaleDateString() : 'Never'}
                      </td>
                      <td className="py-3 px-4 text-right whitespace-nowrap">
                        <button
                          type="button"
                          onClick={() => toggleActive(u)}
                          disabled={isSelf}
                          title={u.active ? 'Disable login' : 'Enable login'}
                          className="p-1.5 text-slate-500 hover:text-slate-900 disabled:opacity-40 cursor-pointer"
                        >
                          {u.active ? (
                            <UserX className="w-4 h-4" />
                          ) : (
                            <UserCheck className="w-4 h-4" />
                          )}
                        </button>
                        <button
                          type="button"
                          onClick={() => deleteUser(u)}
                          disabled={isSelf}
                          title="Delete Login ID"
                          className="p-1.5 text-slate-500 hover:text-red-700 disabled:opacity-40 cursor-pointer ml-1"
                        >
                          <Trash2 className="w-4 h-4" />
                        </button>
                      </td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>
      </section>

      {/* Daily 10:00 AM Scheduler & Export */}
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">
        <section className="lg:col-span-7 bg-white border border-slate-200 rounded-xl p-6">
          <div className="flex items-center justify-between gap-4 pb-4 border-b border-slate-200">
            <div>
              <h3 className="font-display text-base font-semibold text-slate-900">
                10:00 AM IST Daily NPPA Sync History
              </h3>
              <p className="text-xs text-slate-500 mt-0.5">
                Server automatically checks NPPA Circulars, Authority Minutes &amp; Expert Committee daily at 10:00 AM IST.
              </p>
            </div>
            <button
              type="button"
              onClick={runSync}
              disabled={syncing}
              className="inline-flex items-center gap-1.5 px-3.5 py-2 text-xs font-semibold text-white bg-indigo-700 rounded-lg hover:bg-indigo-800 whitespace-nowrap shrink-0 cursor-pointer"
            >
              <RefreshCw className={`w-3.5 h-3.5 ${syncing ? 'animate-spin' : ''}`} />
              {syncing ? 'Syncing…' : 'Run Check Now'}
            </button>
          </div>

          <div className="mt-4 divide-y divide-slate-200">
            {syncLogs.map((log) => (
              <div key={log.id} className="py-3 text-xs flex flex-col sm:flex-row sm:items-center justify-between gap-2">
                <div>
                  <span className="font-semibold text-slate-900">
                    {log.triggeredBy === 'scheduled_10am_ist' ? '10:00 AM IST Cron' : 'Manual Sync'}
                  </span>
                  <span aria-hidden="true" className="mx-2 text-slate-400">·</span>
                  <span className="text-slate-600">{log.message}</span>
                </div>
                <span className="font-mono text-slate-500 whitespace-nowrap shrink-0 tabular-nums">
                  {new Date(log.timestamp).toLocaleString()}
                </span>
              </div>
            ))}
          </div>
        </section>

        <section className="lg:col-span-5 bg-white border border-slate-200 rounded-xl p-6 flex flex-col justify-between">
          <div>
            <h3 className="font-display text-base font-semibold text-slate-900">
              Standalone HTML &amp; GitHub / Render Blueprint
            </h3>
            <p className="text-sm text-slate-600 mt-2 leading-relaxed">
              Export the single-file standalone HTML outlook for quick stakeholder review, or deploy this full repository directly to GitHub and Render (<span className="font-mono text-xs">npm run build</span> &amp; <span className="font-mono text-xs">npm start</span>).
            </p>
          </div>

          <div className="mt-6 flex flex-wrap gap-3">
            <a
              href="/api/export/standalone-html/preview"
              target="_blank"
              rel="noreferrer"
              className="inline-flex items-center gap-2 px-4 py-2 text-xs font-semibold text-indigo-900 bg-[#EEF2FF] border border-indigo-200 rounded-lg hover:bg-indigo-100"
            >
              <Code2 className="w-4 h-4" />
              Preview HTML Page
            </a>
            <a
              href="/api/export/standalone-html"
              className="inline-flex items-center gap-2 px-4 py-2 text-xs font-semibold text-white bg-indigo-700 rounded-lg hover:bg-indigo-800"
            >
              <Download className="w-4 h-4" />
              Download Standalone HTML
            </a>
          </div>
        </section>
      </div>
    </div>
  );
}
