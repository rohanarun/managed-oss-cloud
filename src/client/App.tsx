import { useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { ArrowRight, CalendarBlank, ChartLineUp, Check, Cloud, Copy, CreditCard, Gauge, Globe, HardDrives, List, Lock, Plus, SignOut, Stack, Storefront, User, X } from "@phosphor-icons/react";
import { gsap } from "gsap";
import { ScrollTrigger } from "gsap/ScrollTrigger";
import type { AccountUser, CatalogApp, DashboardData, Installation, Quote } from "../shared/types";

gsap.registerPlugin(ScrollTrigger);

interface PublicConfig {
  productName: string;
  provisioningMode: "dry-run" | "live";
  persistence: "postgres" | "preview-memory";
  billingReady: boolean;
  stripePublishableKey?: string;
  platformFeePercent: number;
  platformFeeMinimumCents: number;
  plans: Array<{ id: string; label: string; memoryMb: number; cpu: number; monthlyCents: number }>;
}

const money = (cents: number) => cents === 0 ? "provider cost pending" : new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(cents / 100);
const api = async <T,>(url: string, options?: RequestInit): Promise<T> => {
  const response = await fetch(url, options);
  const body = response.status === 204 ? null : await response.json();
  if (!response.ok) throw new Error(body?.error ?? "Request failed.");
  return body as T;
};

function useRoute() {
  const [path, setPath] = useState(window.location.pathname);
  useEffect(() => { const listener = () => setPath(window.location.pathname); window.addEventListener("popstate", listener); return () => window.removeEventListener("popstate", listener); }, []);
  const navigate = (next: string) => { window.history.pushState({}, "", next); setPath(next); window.scrollTo({ top: 0, behavior: "smooth" }); };
  return { path, navigate };
}

export function App() {
  const { path, navigate } = useRoute();
  const [catalog, setCatalog] = useState<CatalogApp[]>([]);
  const [config, setConfig] = useState<PublicConfig>({ productName: "Managed OSS Cloud", provisioningMode: "dry-run", persistence: "preview-memory", billingReady: false, platformFeePercent: 12, platformFeeMinimumCents: 200, plans: [] });
  const [user, setUser] = useState<AccountUser | null>(null);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    Promise.all([
      api<PublicConfig>("/api/config"),
      api<CatalogApp[]>("/api/catalog"),
      fetch("/api/me").then((response) => response.ok ? response.json() : { user: null }),
    ]).then(([nextConfig, nextCatalog, me]) => { setConfig(nextConfig); setCatalog(nextCatalog); setUser(me.user); setLoaded(true); });
  }, []);

  if (!loaded) return <div className="loading-screen"><Stack weight="fill" /><span>Opening your workspace</span></div>;
  if (path === "/login" || path === "/signup") return <AuthPage mode={path === "/login" ? "login" : "signup"} config={config} navigate={navigate} onAuthenticated={setUser} />;
  if (path.startsWith("/dashboard")) return user ? <Dashboard config={config} catalog={catalog} user={user} navigate={navigate} onLogout={() => setUser(null)} /> : <AuthPage mode="login" config={config} navigate={navigate} onAuthenticated={setUser} />;
  return <Landing config={config} catalog={catalog} user={user} navigate={navigate} />;
}

function Brand({ name }: { name: string }) {
  return <span className="brand"><span className="brand-mark"><Stack weight="fill" /></span>{name}</span>;
}

function Landing({ config, catalog, user, navigate }: { config: PublicConfig; catalog: CatalogApp[]; user: AccountUser | null; navigate: (path: string) => void }) {
  const [selected, setSelected] = useState<string[]>([]);
  const [quote, setQuote] = useState<Quote | null>(null);
  const [hostingPath, setHostingPath] = useState<"managed" | "self-hosted">("managed");
  const [testimonial, setTestimonial] = useState(0);
  const root = useRef<HTMLElement>(null);
  const process = useRef<HTMLElement>(null);
  const stack = useRef<HTMLDivElement>(null);
  const testimonials = [
    ["I want my booking page and forms on our own domain without becoming a systems administrator.", "Asha", "Independent studio"],
    ["The useful bit is seeing the server cost and management fee as separate numbers.", "Mateo", "Small agency"],
    ["If we outgrow the managed option, we can take the same open stack into our cloud account.", "Inez", "Operations lead"],
  ];

  useEffect(() => {
    const context = gsap.context(() => {
      gsap.from(".hero-reveal", { y: 38, opacity: 0, duration: .9, stagger: .08, ease: "power3.out" });
      gsap.fromTo(".hero-console", { scale: .82, opacity: 0 }, { scale: 1, opacity: 1, duration: 1.1, ease: "power3.out" });
      if (window.innerWidth > 900) ScrollTrigger.create({ trigger: process.current, start: "top 12%", end: "bottom 75%", pin: ".process-heading" });
      gsap.utils.toArray<HTMLElement>(".stack-card").forEach((card, index) => gsap.fromTo(card, { y: 80 + index * 20, scale: .92, opacity: .4 }, { y: 0, scale: 1, opacity: 1, scrollTrigger: { trigger: card, start: "top 88%", end: "top 42%", scrub: true } }));
    }, root);
    return () => context.revert();
  }, []);

  useEffect(() => {
    if (!selected.length) return setQuote(null);
    api<Quote>("/api/quote", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ appIds: selected }) }).then(setQuote);
  }, [selected]);
  const selectedApps = useMemo(() => catalog.filter((item) => selected.includes(item.id)), [catalog, selected]);
  const toggle = (app: CatalogApp) => app.status === "ready" && setSelected((current) => current.includes(app.id) ? current.filter((id) => id !== app.id) : [...current, app.id]);
  const begin = () => navigate(user ? "/dashboard/catalog" : "/signup");

  return <main className="page-shell" ref={root}>
    <nav className="nav-wrap"><a href="#top"><Brand name={config.productName} /></a><div className="nav-links"><a href="#catalog">Catalogue</a><a href="#ownership">Ownership</a><a href="#pricing">Pricing</a></div><div className="nav-user">{user ? <button onClick={() => navigate("/dashboard")}><User /> Dashboard</button> : <><button className="plain" onClick={() => navigate("/login")}>Log in</button><button className="nav-action" onClick={() => navigate("/signup")}>Create account <ArrowRight /></button></>}</div></nav>

    <section className="hero" id="top">
      <div className="hero-copy"><p className="hero-kicker hero-reveal">Open software. Managed simply.</p><h1 className="hero-reveal">Your tools, on your <span className="inline-image" aria-hidden="true" /> own domain.</h1><p className="hero-reveal">Install proven open-source alternatives to scheduling, email, signatures, forms, analytics, and monitoring. Pay for the server plus one visible management fee.</p><div className="hero-actions hero-reveal"><button className="button primary" onClick={begin}>Build your workspace <ArrowRight /></button><a className="button secondary" href="#ownership">See the ownership model</a></div></div>
      <div className="hero-console">
        <div className="console-bar"><span>Your private workspace</span><span><i /> Capacity healthy</span></div>
        <div className="console-app featured"><CalendarBlank /><div><strong>Scheduling</strong><span>calendar.yourdomain.com</span></div><em>Ready</em></div>
        <div className="console-grid"><div><List /><span>Forms</span></div><div><ChartLineUp /><span>Analytics</span></div><div><HardDrives /><span>Monitoring</span></div><div className="console-add"><Plus /><span>Add a tool</span></div></div>
        <div className="console-meter"><div><span>Micro server</span><strong>682 MB available</strong></div><i><b /></i></div>
      </div>
    </section>

    <div className="marquee"><div>{["Custom domains", "Automatic TLS", "Portable data", "Open source", "Transparent pricing", "Capacity controls", "Custom domains", "Automatic TLS"].map((item, index) => <span key={`${item}-${index}`}>{item}</span>)}</div></div>

    <section className="chapter paths" id="ownership"><div className="section-heading"><div><h2>Convenience now.<br />Control forever.</h2></div><p>Start with one-click managed hosting or deploy the same control plane into Google Cloud. Your domain and application data stay portable.</p></div><div className="path-accordions">
      <article className={hostingPath === "managed" ? "active" : ""} onMouseEnter={() => setHostingPath("managed")}><Cloud weight="duotone" /><div><small>Managed</small><h3>We operate the stack.</h3><p>Accounts, CNAME instructions, TLS, backups, and capacity upgrades live in one dashboard.</p></div><ul><li><Check />One-click plans</li><li><Check />Itemized monthly pricing</li><li><Check />Export path retained</li></ul><button className="button primary" onClick={begin}>Use managed hosting</button></article>
      <article className={hostingPath === "self-hosted" ? "active" : ""} onMouseEnter={() => setHostingPath("self-hosted")}><HardDrives weight="duotone" /><div><small>Self-hosted</small><h3>You operate the stack.</h3><p>Run the MIT-licensed control plane in your Google Cloud project and pay Google directly.</p></div><ul><li><Check />Terraform starter</li><li><Check />Private cloud account</li><li><Check />No platform lock-in</li></ul><a className="button secondary" href="https://github.com/rohanarun/managed-oss-cloud">View source</a></article>
    </div></section>

    <section className="chapter catalog-section" id="catalog"><div className="section-heading"><div><h2>Known software.<br />One calm catalogue.</h2></div><p>Versions and licenses are explicit. “Verification” means we are still testing deployment, backup, restore, or an external integration.</p></div><div className="catalog-layout"><div className="app-grid">{catalog.map((app) => {
      const selectedNow = selected.includes(app.id); return <button className={`app-card ${selectedNow ? "selected" : ""} ${app.status !== "ready" ? "pending" : ""}`} key={app.id} onClick={() => toggle(app)}>
        <div className="app-card-head"><span className="app-monogram">{app.name.slice(0, 1)}</span><span className="app-status">{app.status === "ready" ? selectedNow ? <Check /> : <Plus /> : <Lock />}</span></div><div><span className="category">{app.category} · {app.license}</span><h3>{app.name}</h3><p>{app.description}</p></div><div className="app-meta"><span>Replaces {app.replaces}</span><span>{app.version}</span></div>{app.status !== "ready" && <span className="verification-note">Deployment verification in progress</span>}
      </button>;
    })}</div><aside className="quote-panel" id="pricing"><div className="quote-title"><Cloud /><div><span>Workspace estimate</span><strong>{selected.length ? `${selected.length} selected` : "Choose plan-ready tools"}</strong></div></div><div className="selected-list">{selectedApps.map((app) => <div key={app.id}><span>{app.name}</span><button onClick={() => toggle(app)}><X /></button></div>)}</div>{quote ? <><div className="quote-capacity"><span>Planned memory</span><strong>{quote.requestedMemoryMb} MB</strong></div><p className="fit-note">{quote.explanation}</p><div className="price-lines"><div><span>Cloud infrastructure</span><span>{money(quote.infrastructureMonthlyCents)}</span></div><div><span>Management fee</span><span>{money(quote.platformFeeCents)}</span></div><div className="total"><span>Estimated total</span><strong>{money(quote.totalMonthlyCents)}</strong></div></div><button className="button primary full" onClick={begin}>Continue in dashboard <ArrowRight /></button></> : <p className="empty-quote">Select a plan-ready tool to calculate capacity. Google Cloud prices remain unquoted until the owning project and region are confirmed.</p>}</aside></div></section>

    <section className="bento" aria-label="Hosting capabilities"><article className="bento-lead"><Globe /><h2>Share every tool through your domain.</h2><p>Copy the displayed CNAME, watch verification status, and keep the target hostname available for DNS changes.</p><div className="dns-row"><span>calendar.company.com</span><ArrowRight /><strong>workspace.apps.example.com</strong></div></article><article className="bento-small dark"><Gauge /><h3>Capacity before guesswork</h3><p>Apps are admitted only when the server retains a safety reserve.</p></article><article className="bento-small blue"><CreditCard /><h3>One fee, separately shown</h3><p>Infrastructure and our management fee never become one mystery line.</p></article></section>

    <section className="process chapter" ref={process}><div className="process-heading"><h2>A server that grows one deliberate step at a time.</h2></div><div className="process-copy" ref={stack}><article className="stack-card"><span>Choose</span><h3>Build the smallest safe stack</h3><p>Select verified apps and see which machine can hold them without exhausting memory.</p></article><article className="stack-card"><span>Connect</span><h3>Use a domain people recognize</h3><p>Add the exact CNAME from the dashboard. Certificate work starts only after DNS resolves.</p></article><article className="stack-card"><span>Grow</span><h3>Approve a larger machine</h3><p>The dashboard preserves apps and hostnames while the provider upgrade is reconciled.</p></article></div></section>

    <section className="testimonials chapter"><div><h2>Built for people who want ownership without a second job.</h2><div className="testimonial-controls"><button onClick={() => setTestimonial((testimonial + 2) % 3)}>←</button><button onClick={() => setTestimonial((testimonial + 1) % 3)}>→</button></div></div><blockquote><p>“{testimonials[testimonial][0]}”</p><footer><strong>{testimonials[testimonial][1]}</strong><span>{testimonials[testimonial][2]}</span></footer></blockquote></section>

    <footer className="site-footer"><div><h2>Put your daily tools<br />under one roof.</h2><button className="button light" onClick={begin}>Create your workspace <ArrowRight /></button></div><div className="footer-bottom"><Brand name={config.productName} /><span>Open-source control plane · Portable infrastructure · Transparent fees</span></div></footer>
  </main>;
}

function AuthPage({ mode, config, navigate, onAuthenticated }: { mode: "login" | "signup"; config: PublicConfig; navigate: (path: string) => void; onAuthenticated: (user: AccountUser) => void }) {
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setBusy(true); setError("");
    const data = new FormData(event.currentTarget);
    try {
      const result = await api<{ user: AccountUser }>(`/api/auth/${mode === "signup" ? "signup" : "login"}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ displayName: data.get("displayName"), email: data.get("email"), password: data.get("password") }) });
      onAuthenticated(result.user); navigate("/dashboard");
    } catch (nextError) { setError(nextError instanceof Error ? nextError.message : "Could not continue."); } finally { setBusy(false); }
  }
  return <main className="auth-shell"><section className="auth-story"><button className="back-link" onClick={() => navigate("/")}>← Back to site</button><Brand name={config.productName} /><h1>Your private software workspace starts here.</h1><p>Use one account to install tools, connect domains, see capacity, and approve upgrades.</p><div className="auth-proof"><Lock /><span>Passwords use salted scrypt hashes. Sessions stay in secure, HTTP-only cookies.</span></div></section><section className="auth-panel"><form onSubmit={submit}><span>{mode === "signup" ? "Create your account" : "Welcome back"}</span><h2>{mode === "signup" ? "Build your workspace" : "Log in to your dashboard"}</h2>{mode === "signup" && <label>Name<input name="displayName" autoComplete="name" required minLength={2} /></label>}<label>Email<input name="email" type="email" autoComplete="email" required /></label><label>Password<input name="password" type="password" autoComplete={mode === "signup" ? "new-password" : "current-password"} required minLength={mode === "signup" ? 10 : 1} /></label>{error && <p className="form-error">{error}</p>}<button className="button primary full" disabled={busy}>{busy ? "Working…" : mode === "signup" ? "Create account" : "Log in"}<ArrowRight /></button><p>{mode === "signup" ? "Already have an account?" : "Need an account?"} <button type="button" onClick={() => navigate(mode === "signup" ? "/login" : "/signup")}>{mode === "signup" ? "Log in" : "Sign up"}</button></p>{config.persistence === "preview-memory" && <div className="preview-warning">Preview mode: accounts reset when this demo restarts. PostgreSQL enables durable accounts.</div>}</form></section></main>;
}

function Dashboard({ config, catalog, user, navigate, onLogout }: { config: PublicConfig; catalog: CatalogApp[]; user: AccountUser; navigate: (path: string) => void; onLogout: () => void }) {
  const [data, setData] = useState<DashboardData | null>(null);
  const [section, setSection] = useState(window.location.pathname.split("/")[2] || "overview");
  const [selected, setSelected] = useState<string[]>([]);
  const [serverName, setServerName] = useState("my-workspace");
  const [active, setActive] = useState<Installation | null>(null);
  const [domain, setDomain] = useState("");
  const [notice, setNotice] = useState("");
  const load = () => api<DashboardData>("/api/dashboard").then(setData);
  useEffect(() => { load(); }, []);
  const go = (next: string) => { setSection(next); window.history.pushState({}, "", `/dashboard/${next === "overview" ? "" : next}`); };
  async function createPlan() { try { const result = await api<{ installation: Installation }>("/api/installations", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ appIds: selected, name: serverName }) }); setActive(result.installation); setNotice(config.billingReady ? "Server plan saved. Review it, then continue to secure checkout." : "Server plan saved. Checkout remains locked until production billing is verified."); setSelected([]); await load(); go("servers"); } catch (error) { setNotice(error instanceof Error ? error.message : "Could not save plan."); } }
  async function addDomain() { if (!active) return; try { const result = await api<{ installation: Installation; dns: { name: string; value: string } }>(`/api/installations/${active.id}/domains`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ domain }) }); setActive(result.installation); setDomain(""); setNotice(`Add a CNAME from ${result.dns.name} to ${result.dns.value}.`); await load(); } catch (error) { setNotice(error instanceof Error ? error.message : "Could not add domain."); } }
  async function upgrade(plan: string) { if (!active) return; try { const result = await api<{ installation: Installation }>(`/api/installations/${active.id}/upgrade`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ plan }) }); setActive(result.installation); setNotice(`Upgrade to ${plan} saved. No provider change occurs until billing is enabled.`); await load(); } catch (error) { setNotice(error instanceof Error ? error.message : "Could not plan upgrade."); } }
  async function verifyDomainName(name: string) { if (!active) return; try { const result = await api<{ method: string; expected: string }>(`/api/installations/${active.id}/domains/${encodeURIComponent(name)}/verify`, { method: "POST" }); setNotice(`${name} verified by ${result.method}. TLS routing is now queued.`); await load(); } catch (error) { setNotice(error instanceof Error ? error.message : "DNS is not ready yet."); } }
  async function startCheckout() { if (!active) return setNotice("Select a planned server before checkout."); try { const result = await api<{ url: string | null }>("/api/billing/checkout", { method: "POST", headers: { "Content-Type": "application/json", "Idempotency-Key": `checkout:${active.id}:${crypto.randomUUID()}` }, body: JSON.stringify({ installationId: active.id }) }); if (!result.url) throw new Error("Stripe did not return a checkout URL."); window.location.assign(result.url); } catch (error) { setNotice(error instanceof Error ? error.message : "Checkout could not start."); } }
  async function logout() { await api("/api/auth/logout", { method: "POST" }); onLogout(); navigate("/"); }
  const installations = data?.installations ?? [];
  const usedMemory = active ? catalog.filter((app) => active.appIds.includes(app.id)).reduce((sum, app) => sum + app.memoryBudgetMb, 0) : 0;
  const currentPlan = active ? config.plans.find((plan) => plan.id === active.plan) : undefined;
  return <main className="dashboard-shell"><aside className="dashboard-sidebar"><button className="dashboard-brand" onClick={() => navigate("/")}><Brand name={config.productName} /></button><nav>{[["overview", Gauge, "Overview"], ["catalog", Storefront, "Catalogue"], ["servers", HardDrives, "Servers"], ["domains", Globe, "Domains"], ["billing", CreditCard, "Billing"]].map(([id, Icon, label]) => <button key={String(id)} className={section === id ? "active" : ""} onClick={() => go(String(id))}><Icon />{String(label)}</button>)}</nav><div className="account-card"><span>{user.displayName.slice(0, 1).toUpperCase()}</span><div><strong>{user.displayName}</strong><small>{user.email}</small></div><button onClick={logout}><SignOut /></button></div></aside><section className="dashboard-main"><header><div><span>Workspace control plane</span><h1>{section === "overview" ? `Good to see you, ${user.displayName.split(" ")[0]}.` : section[0].toUpperCase() + section.slice(1)}</h1></div><button className="button primary" onClick={() => go("catalog")}><Plus /> Install software</button></header>{notice && <div className="notice">{notice}<button onClick={() => setNotice("")}><X /></button></div>}
    {section === "overview" && <><div className="metric-grid"><article><span>Servers</span><strong>{installations.length}</strong><small>{installations.filter((item) => item.state === "live").length} live</small></article><article><span>Installed tools</span><strong>{installations.reduce((total, item) => total + item.appIds.length, 0)}</strong><small>Across all servers</small></article><article><span>Custom domains</span><strong>{installations.reduce((total, item) => total + item.customDomains.length, 0)}</strong><small>Awaiting DNS or active</small></article></div><div className="dashboard-banner"><div><Cloud /><span>Provisioning mode</span><strong>{config.provisioningMode === "dry-run" ? "Safe planning only" : "Live"}</strong></div><p>No cloud resource or charge is created while billing and provider reconciliation are locked.</p></div><ServerTable installations={installations} catalog={catalog} onSelect={(item) => { setActive(item); go("servers"); }} /></>}
    {section === "catalog" && <div className="dashboard-catalog"><div className="catalog-toolbar"><div><strong>{selected.length} selected</strong><span>Only verified apps can be planned.</span></div><label>Server name<input value={serverName} onChange={(event) => setServerName(event.target.value)} /></label><button className="button primary" disabled={!selected.length} onClick={createPlan}>Save server plan</button></div><div className="dashboard-app-grid">{catalog.map((app) => <button key={app.id} disabled={app.status !== "ready"} className={selected.includes(app.id) ? "selected" : ""} onClick={() => setSelected((items) => items.includes(app.id) ? items.filter((id) => id !== app.id) : [...items, app.id])}><div><span className="app-monogram">{app.name[0]}</span><span>{app.status === "ready" ? "Plan ready" : "Verification"}</span></div><h3>{app.name}</h3><p>{app.description}</p><footer><span>{app.version}</span><span>{app.memoryBudgetMb} MB</span></footer></button>)}</div></div>}
    {section === "servers" && <div className="management-grid"><ServerTable installations={installations} catalog={catalog} onSelect={setActive} />{active ? <div className="server-detail"><div><HardDrives /><span>{active.state}</span></div><h2>{active.name}</h2><p>{active.failureReason || active.hostname}</p>{active.applications?.map((application) => <div className="managed-app" key={application.id}><span>{catalog.find((item) => item.id === application.appId)?.name ?? application.appId}</span><strong>{application.state}</strong>{application.state === "live" && <a href={`https://${application.hostname}`} target="_blank" rel="noreferrer">Open <ArrowRight /></a>}</div>)}<div className="capacity-bar"><span>Planned memory: {usedMemory} MB of {currentPlan?.memoryMb ?? 0} MB</span><i><b style={{ width: `${Math.min(100, (usedMemory / (currentPlan?.memoryMb || 1)) * 100)}%` }} /></i></div><h3>Upgrade capacity</h3><div className="plan-buttons">{config.plans.map((plan) => <button key={plan.id} disabled={plan.id === active.plan} onClick={() => upgrade(plan.id)}><strong>{plan.label}</strong><span>{plan.memoryMb / 1024} GB · {money(plan.monthlyCents)}</span></button>)}</div></div> : <div className="empty-panel"><HardDrives /><p>Select a server to manage capacity.</p></div>}</div>}
    {section === "domains" && <div className="management-grid"><ServerTable installations={installations} catalog={catalog} onSelect={setActive} />{active ? <div className="server-detail"><div><Globe /><span>DNS settings</span></div><h2>{active.name}</h2><p>Point a CNAME to {active.applications?.[0]?.hostname ?? active.hostname}, then verify it here.</p><label className="domain-input"><input placeholder="tool.yourdomain.com" value={domain} onChange={(event) => setDomain(event.target.value)} /><button onClick={addDomain}>Add CNAME</button></label><div className="domain-list">{active.customDomains.map((item) => <div key={item}><span><i />{item}</span><button onClick={() => navigator.clipboard.writeText(active.applications?.[0]?.hostname ?? active.hostname)}><Copy /> Target</button><button onClick={() => verifyDomainName(item)}>Verify DNS</button></div>)}</div></div> : <div className="empty-panel"><Globe /><p>Select a server before adding a domain.</p></div>}</div>}
    {section === "billing" && <div className="billing-page"><article><CreditCard /><span>Billing status</span><h2>{config.billingReady ? "Secure checkout ready" : "Safely disabled"}</h2><p>{config.billingReady ? "Stripe itemizes infrastructure and the management fee. Provisioning begins only after a signed paid webhook." : "Checkout remains disabled until the production webhook and domain are verified end to end."}</p><button className="button primary" disabled={!config.billingReady || !active || active.state !== "planned"} onClick={startCheckout}>{active ? `Checkout for ${active.name}` : "Select a planned server"}</button></article><article><h3>How each bill is calculated</h3><div><span>Cloud infrastructure</span><strong>Configured allocation</strong></div><div><span>Management fee</span><strong>{config.platformFeePercent}% or {money(config.platformFeeMinimumCents)} minimum</strong></div><div><span>Custom domain</span><strong>Included</strong></div></article></div>}
  </section></main>;
}

function ServerTable({ installations, catalog, onSelect }: { installations: Installation[]; catalog: CatalogApp[]; onSelect: (item: Installation) => void }) {
  return <div className="server-table"><div className="table-heading"><strong>Your servers</strong><span>{installations.length} total</span></div>{installations.length ? installations.map((item) => <button key={item.id} onClick={() => onSelect(item)}><span className="server-icon"><HardDrives /></span><div><strong>{item.name}</strong><span>{item.appIds.map((id) => catalog.find((app) => app.id === id)?.name).filter(Boolean).join(", ")}</span></div><span className="state">{item.state.replace("_", " ")}</span><ArrowRight /></button>) : <div className="empty-table"><Cloud /><span>No server plans yet.</span></div>}</div>;
}
