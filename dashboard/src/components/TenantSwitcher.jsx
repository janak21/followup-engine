"use client";

import { useEffect, useState } from "react";
import { ChevronDown, Plus, Hexagon } from "lucide-react";
import { useRouter } from "next/navigation";

export function TenantSwitcher({ isCollapsed = false }) {
  const [tenants, setTenants] = useState([]);
  const [activeTenant, setActiveTenant] = useState(null);
  const [isOpen, setIsOpen] = useState(false);
  const [isModalOpen, setIsModalOpen] = useState(false);
  
  // Add Tenant Form State
  const [newTenantName, setNewTenantName] = useState("");
  const [newTenantTimezone, setNewTenantTimezone] = useState("America/New_York");
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState(null);
  
  const router = useRouter();

  useEffect(() => {
    // Fetch tenants
    fetch("/api/tenants")
      .then(res => res.json())
      .then(data => {
        if (data.data) {
          setTenants(data.data);
          
          // Determine active tenant from cookie or default to first
          const cookieTenantId = document.cookie
            .split('; ')
            .find(row => row.startsWith('tenant_id='))
            ?.split('=')[1];
            
          if (cookieTenantId) {
            const current = data.data.find(t => t.id === cookieTenantId);
            if (current) setActiveTenant(current);
            else if (data.data.length > 0) setActiveTenant(data.data[0]);
          } else if (data.data.length > 0) {
            setActiveTenant(data.data[0]);
          }
        }
      })
      .catch(err => console.error("Failed to load tenants", err));
  }, []);

  const switchTenant = (tenant) => {
    document.cookie = `tenant_id=${tenant.id}; path=/; max-age=31536000`; // 1 year expiry
    setActiveTenant(tenant);
    setIsOpen(false);
    window.location.reload(); // Refresh the page to reload data for new tenant
  };

  const handleAddTenant = async (e) => {
    e.preventDefault();
    setIsSubmitting(true);
    setError(null);
    try {
      const res = await fetch("/api/tenants", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: newTenantName,
          timezone: newTenantTimezone,
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        throw new Error(data.error || "Failed to create tenant");
      }
      
      // Tenant created, set it as active
      document.cookie = `tenant_id=${data.data.id}; path=/; max-age=31536000`;
      window.location.reload();
    } catch (err) {
      setError(err.message);
      setIsSubmitting(false);
    }
  };

  return (
    <div className="relative w-full">
      {/* Dropdown Toggle */}
      <button
        type="button"
        className={`flex w-full items-center ${isCollapsed ? "justify-center p-1.5" : "justify-between px-3 py-3"} rounded-xl cursor-pointer hover:bg-zinc-950/5 dark:hover:bg-white/5 transition-all duration-300 border border-transparent hover:border-black/10 dark:hover:border-white/10 group focus-visible:ring-3 focus-visible:ring-ring/60 focus-visible:ring-offset-2 focus-visible:ring-offset-background`}
        onClick={() => setIsOpen(!isOpen)}
        aria-label={activeTenant ? `Switch workspace. Current workspace: ${activeTenant.name}` : "Switch workspace"}
        aria-expanded={isOpen}
        aria-haspopup="menu"
        title={isCollapsed && activeTenant ? `Switch Tenant: ${activeTenant.name}` : undefined}
      >
        <div className={`flex items-center ${isCollapsed ? "" : "overflow-hidden"}`}>
          <div className="w-8 h-8 rounded-lg bg-gradient-to-br from-indigo-500 to-purple-600 p-[1px] shadow-sm flex-shrink-0">
            <div className="w-full h-full bg-white dark:bg-black rounded-lg flex items-center justify-center">
              <Hexagon className="w-4 h-4 text-indigo-600 dark:text-indigo-400" />
            </div>
          </div>
          {!isCollapsed && (
            <div className="flex flex-col overflow-hidden ml-3">
              <span className="text-xs font-semibold text-zinc-600 dark:text-zinc-300 uppercase tracking-wider">Tenant</span>
              <span className="text-sm font-medium text-zinc-900 dark:text-white truncate">
                {activeTenant ? activeTenant.name : "Loading..."}
              </span>
            </div>
          )}
        </div>
        {!isCollapsed && (
          <ChevronDown className="w-4 h-4 text-zinc-400 group-hover:text-zinc-600 dark:group-hover:text-zinc-300" />
        )}
      </button>

      {/* Dropdown Menu */}
      {isOpen && (
        <>
          <div 
            className="fixed inset-0 z-40" 
            onClick={() => setIsOpen(false)} 
          />
          <div className={`absolute top-full left-0 ${isCollapsed ? "w-56" : "right-0"} mt-2 z-50 bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-800 rounded-xl shadow-xl overflow-hidden py-2`} role="menu">
            <div className="px-3 py-2 text-xs font-semibold text-zinc-600 dark:text-zinc-300 uppercase tracking-wider">
              Switch Tenant
            </div>
            {tenants.map(t => (
              <button
                type="button"
                key={t.id}
                onClick={() => switchTenant(t)}
                className={`block w-full px-4 py-2 text-left text-sm cursor-pointer hover:bg-zinc-100 dark:hover:bg-zinc-800 transition-colors focus-visible:ring-3 focus-visible:ring-ring/60 focus-visible:ring-inset ${activeTenant?.id === t.id ? 'bg-indigo-50/50 dark:bg-indigo-900/20 text-indigo-700 dark:text-indigo-300 font-medium' : 'text-zinc-700 dark:text-zinc-300'}`}
                role="menuitem"
              >
                {t.name}
              </button>
            ))}
            <div className="border-t border-zinc-100 dark:border-zinc-800 mt-2 pt-2">
              <button
                type="button"
                onClick={() => {
                  setIsOpen(false);
                  setIsModalOpen(true);
                }}
                className="flex w-full items-center px-4 py-2 text-left text-sm cursor-pointer hover:bg-zinc-100 dark:hover:bg-zinc-800 text-zinc-700 dark:text-zinc-300 transition-colors focus-visible:ring-3 focus-visible:ring-ring/60 focus-visible:ring-inset"
                role="menuitem"
              >
                <Plus className="w-4 h-4 mr-2" />
                Add new tenant
              </button>
            </div>
          </div>
        </>
      )}

      {/* Add Tenant Modal */}
      {isModalOpen && (
        <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/50 backdrop-blur-sm">
          <div className="bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-800 rounded-2xl p-6 w-full max-w-md shadow-2xl relative">
            <h2 className="text-xl font-bold text-zinc-900 dark:text-white mb-1">Add New Tenant</h2>
            <p className="text-sm text-zinc-600 dark:text-zinc-300 mb-6">Create a new isolated workspace.</p>
            
            <form onSubmit={handleAddTenant} className="space-y-4">
              <div>
                <label className="block text-sm font-medium text-zinc-700 dark:text-zinc-300 mb-1">Tenant Name</label>
                <input 
                  type="text" 
                  value={newTenantName}
                  onChange={(e) => setNewTenantName(e.target.value)}
                  className="w-full px-3 py-2 bg-zinc-50 dark:bg-zinc-800/50 border border-zinc-200 dark:border-zinc-700/50 rounded-lg text-sm text-zinc-900 dark:text-zinc-100 outline-none focus-visible:ring-3 focus-visible:ring-ring/60 focus-visible:ring-offset-2 focus-visible:ring-offset-background"
                  placeholder="e.g. Acme Agency"
                  required
                />
              </div>
              
              <div>
                <label className="block text-sm font-medium text-zinc-700 dark:text-zinc-300 mb-1">Timezone</label>
                <select 
                  value={newTenantTimezone}
                  onChange={(e) => setNewTenantTimezone(e.target.value)}
                  className="w-full px-3 py-2 bg-zinc-50 dark:bg-zinc-800/50 border border-zinc-200 dark:border-zinc-700/50 rounded-lg text-sm text-zinc-900 dark:text-zinc-100 outline-none focus-visible:ring-3 focus-visible:ring-ring/60 focus-visible:ring-offset-2 focus-visible:ring-offset-background"
                >
                  <option value="America/New_York">Eastern Time (US)</option>
                  <option value="America/Chicago">Central Time (US)</option>
                  <option value="America/Denver">Mountain Time (US)</option>
                  <option value="America/Los_Angeles">Pacific Time (US)</option>
                  <option value="UTC">UTC</option>
                </select>
              </div>

              {error && (
                <div className="p-3 bg-red-50 dark:bg-red-500/10 text-red-600 dark:text-red-400 text-sm rounded-lg border border-red-200 dark:border-red-500/20">
                  {error}
                </div>
              )}

              <div className="flex justify-end space-x-3 pt-4">
                <button
                  type="button"
                  onClick={() => setIsModalOpen(false)}
                  className="px-4 py-2 text-sm font-medium text-zinc-700 dark:text-zinc-300 hover:bg-zinc-100 dark:hover:bg-zinc-800 rounded-lg transition-colors focus-visible:ring-3 focus-visible:ring-ring/60 focus-visible:ring-offset-2 focus-visible:ring-offset-background"
                  disabled={isSubmitting}
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={isSubmitting || !newTenantName}
                  className="px-4 py-2 text-sm font-medium bg-zinc-900 hover:bg-zinc-800 dark:bg-white dark:hover:bg-zinc-100 text-white dark:text-zinc-900 rounded-lg transition-colors disabled:cursor-not-allowed disabled:opacity-65 focus-visible:ring-3 focus-visible:ring-ring/60 focus-visible:ring-offset-2 focus-visible:ring-offset-background"
                >
                  {isSubmitting ? "Creating..." : "Create Tenant"}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
