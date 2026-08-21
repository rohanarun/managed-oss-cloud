import { useEffect, useMemo, useRef, useState } from "react";
import { ArrowRight, Check, Cloud, Copy, Gauge, Globe, HardDrives, Plus, Stack, X } from "@phosphor-icons/react";
import { gsap } from "gsap";
import { ScrollTrigger } from "gsap/ScrollTrigger";
import type { CatalogApp, Installation, Quote } from "../shared/types";

gsap.registerPlugin(ScrollTrigger);

interface PublicConfig {
  productName: string;
  provisioningMode: "dry-run" | "live";
  plans: Array<{ id: string; memoryMb: number; cpu: number; monthlyCents: number }>;
}

const money = (cents: number) => new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(cents / 100);

export function App() {
  const [catalog, setCatalog] = useState<CatalogApp[]>([]);
  const [config, setConfig] = useState<PublicConfig>({ productName: "Managed OSS Cloud", provisioningMode: "dry-run", plans: [] });
  const [selected, setSelected] = useState<string[]>([]);
  const [quote, setQuote] = useState<Quote | null>(null);
  const [installations, setInstallations] = useState<Installation[]>([]);
  const [serverName, setServerName] = useState("my-workspace");
  const [notice, setNotice] = useState("");
  const [activeInstallation, setActiveInstallation] = useState<Installation | null>(null);
  const [domain, setDomain] = useState("");
  const [hostingPath, setHostingPath] = useState<"managed" | "self-hosted">("managed");
  const heroRef = useRef<HTMLElement>(null);
  const howRef = useRef<HTMLElement>(null);

  useEffect(() => {
    Promise.all([
      fetch("/api/config").then((response) => response.json()),
      fetch("/api/catalog").then((response) => response.json()),
      fetch("/api/installations").then((response) => response.json()),
    ]).then(([nextConfig, nextCatalog, nextInstallations]) => {
      setConfig(nextConfig);
      setCatalog(nextCatalog);
      setInstallations(nextInstallations);
    });
  }, []);

  useEffect(() => {
    const context = gsap.context(() => {
      gsap.from(".hero-line", { y: 44, opacity: 0, duration: 1, stagger: 0.08, ease: "power3.out" });
      gsap.fromTo(".server-visual", { scale: 0.82, opacity: 0 }, { scale: 1, opacity: 1, duration: 1.2, ease: "power3.out", delay: 0.2 });
      const words = gsap.utils.toArray<HTMLElement>(".reveal-word");
      gsap.fromTo(words, { opacity: 0.12 }, {
        opacity: 1,
        stagger: 0.05,
        scrollTrigger: { trigger: howRef.current, start: "top 65%", end: "bottom 60%", scrub: true },
      });
      if (window.innerWidth > 900) {
        ScrollTrigger.create({ trigger: howRef.current, start: "top 10%", end: "bottom 75%", pin: ".process-heading" });
      }
    }, heroRef);
    return () => context.revert();
  }, []);

  useEffect(() => {
    if (!selected.length) {
      setQuote(null);
      return;
    }
    fetch("/api/quote", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ appIds: selected }) })
      .then((response) => response.json())
      .then(setQuote);
  }, [selected]);

  const selectedApps = useMemo(() => catalog.filter((app) => selected.includes(app.id)), [catalog, selected]);
  const toggle = (id: string) => setSelected((current) => current.includes(id) ? current.filter((item) => item !== id) : [...current, id]);

  async function createServer() {
    const response = await fetch("/api/installations", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ appIds: selected, name: serverName }),
    });
    const result = await response.json();
    if (!response.ok) return setNotice(result.error);
    setInstallations((current) => [result.installation, ...current]);
    setActiveInstallation(result.installation);
    setNotice(config.provisioningMode === "dry-run" ? "Plan created safely. Live Render provisioning is locked until billing is connected." : "Server provisioning started.");
  }

  async function addDomain() {
    if (!activeInstallation) return;
    const response = await fetch(`/api/installations/${activeInstallation.id}/domains`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ domain }),
    });
    const result = await response.json();
    if (!response.ok) return setNotice(result.error);
    setActiveInstallation(result.installation);
    setInstallations((items) => items.map((item) => item.id === result.installation.id ? result.installation : item));
    setNotice(`Add a CNAME from ${result.dns.name} to ${result.dns.value}. TLS will activate after DNS verifies.`);
    setDomain("");
  }

  async function upgradeServer(plan: string) {
    if (!activeInstallation) return;
    const response = await fetch(`/api/installations/${activeInstallation.id}/upgrade`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ plan }),
    });
    const result = await response.json();
    if (!response.ok) return setNotice(result.error);
    setActiveInstallation(result.installation);
    setInstallations((items) => items.map((item) => item.id === result.installation.id ? result.installation : item));
    setNotice(config.provisioningMode === "dry-run" ? `Upgrade to ${plan} planned. Live changes remain locked.` : `Upgrade to ${plan} started.`);
  }

  return (
    <main className="page-shell" ref={heroRef}>
      <nav className="nav-wrap">
        <a className="brand" href="#top"><span className="brand-mark"><Stack weight="fill" /></span>{config.productName}</a>
        <div className="nav-links"><a href="#catalog">Catalogue</a><a href="#how">How it works</a><a href="#servers">Your servers</a></div>
        <a className="nav-action" href="#catalog">Build a server <ArrowRight /></a>
      </nav>

      <section className="hero" id="top">
        <div className="hero-copy">
          <h1 className="hero-line">Your business tools.<br /><span>Your domain. Your choice.</span></h1>
          <p className="hero-line">Use our one-click hosted service or deploy the same open-source stack into your own Google Cloud account.</p>
          <div className="hero-actions hero-line"><a className="button primary" href="#paths">Host it for me <ArrowRight /></a><a className="button secondary" href="#self-host">Self-host on Google Cloud</a></div>
        </div>
        <div className="server-visual" aria-label="Private server capacity preview">
          <div className="visual-top"><span>Private server</span><span className="live-dot">Ready</span></div>
          <div className="server-core"><HardDrives weight="duotone" /><div><strong>my-workspace</strong><span>Starter · 512 MB</span></div><Gauge /></div>
          <div className="mini-apps"><div><span>L</span>linkding</div><div><span>U</span>Uptime Kuma</div><div className="add-mini"><Plus /> Add tool</div></div>
          <div className="capacity"><div><span>Safe capacity</span><span>67%</span></div><i><b /></i></div>
        </div>
      </section>

      <div className="marquee"><div>{["Your domain", "Automatic TLS", "Private data", "Open-source", "Usage pricing", "One-click upgrades", "Your domain", "Automatic TLS", "Private data", "Open-source"].map((item, index) => <span key={`${item}-${index}`}>{item}</span>)}</div></div>

      <section className="hosting-paths" id="paths">
        <div className="section-heading"><div><span className="eyebrow">Two ways to own it</span><h2>One catalogue.<br />Two deployment paths.</h2></div><p>The software stays open source in both. Choose convenience now and export later, or place the entire stack in your own cloud account from day one.</p></div>
        <div className="path-accordions">
          <article className={hostingPath === "managed" ? "active" : ""} onMouseEnter={() => setHostingPath("managed")}>
            <Cloud weight="duotone" />
            <div><span>Managed hosting</span><h3>We run it for you.</h3><p>Choose tools, connect a CNAME, and open each application from one dashboard. We handle routing, TLS, updates, backups, and capacity.</p></div>
            <ul><li><Check />From $4 per month on pooled compute</li><li><Check />Custom domains included</li><li><Check />One-click capacity upgrades</li></ul>
            <a className="button primary" href="#catalog" onClick={() => setHostingPath("managed")}>Choose hosted tools <ArrowRight /></a>
          </article>
          <article className={hostingPath === "self-hosted" ? "active" : ""} onMouseEnter={() => setHostingPath("self-hosted")}>
            <HardDrives weight="duotone" />
            <div><span>Open-source self-hosting</span><h3>Run it in Google Cloud.</h3><p>Deploy a private Docker host into your billing account, point your domains at it, and keep complete control of the data and infrastructure.</p></div>
            <ul><li><Check />Software and control plane remain free</li><li><Check />Free-tier eligible for one micro VM</li><li><Check />Install within available server capacity</li></ul>
            <a className="button secondary" href="#self-host" onClick={() => setHostingPath("self-hosted")}>View deployment guide <ArrowRight /></a>
          </article>
        </div>
      </section>

      <section className="catalog-section" id="catalog">
        <div className="section-heading"><div><span className="eyebrow">Unlimited catalogue</span><h2>Pick the software.<br />We pack the server.</h2></div><p>Install as many free tools as the chosen server can safely handle. Lightweight apps share compute; heavy apps trigger an upgrade or isolated service.</p></div>
        <div className="catalog-layout">
          <div className="app-grid">
            {catalog.map((app) => {
              const isSelected = selected.includes(app.id);
              return <button className={`app-card ${isSelected ? "selected" : ""}`} key={app.id} onClick={() => toggle(app.id)}>
                <div className="app-card-head"><span className="app-monogram">{app.name.slice(0, 1)}</span><span className="check-circle">{isSelected ? <Check weight="bold" /> : <Plus />}</span></div>
                <div><span className="category">{app.category}</span><h3>{app.name}</h3><p>{app.description}</p></div>
                <div className="app-meta"><span>instead of {app.replaces}</span><span>{app.memoryBudgetMb} MB budget</span></div>
              </button>;
            })}
          </div>
          <aside className="quote-panel">
            <div className="quote-title"><Cloud weight="duotone" /><div><span>Your private server</span><strong>{selected.length ? `${selected.length} tool${selected.length > 1 ? "s" : ""}` : "Choose tools"}</strong></div></div>
            <div className="selected-list">{selectedApps.map((app) => <div key={app.id}><span>{app.name}</span><button onClick={() => toggle(app.id)} aria-label={`Remove ${app.name}`}><X /></button></div>)}</div>
            {quote ? <>
              <div className="quote-capacity"><span>Planned memory</span><strong>{quote.requestedMemoryMb} MB</strong></div>
              <div className={`fit-note ${quote.requiresSplit ? "split" : ""}`}>{quote.explanation}</div>
              <div className="price-lines"><div><span>Render infrastructure</span><span>{money(quote.renderMonthlyCents)}</span></div><div><span>Management fee</span><span>{money(quote.platformFeeCents)}</span></div><div className="total"><span>Estimated monthly total</span><strong>{money(quote.totalMonthlyCents)}</strong></div></div>
              <label className="server-name">Server name<input value={serverName} onChange={(event) => setServerName(event.target.value)} /></label>
              <button className="button primary full" onClick={createServer} disabled={!quote.recommendedPlan}>Create server plan <ArrowRight /></button>
            </> : <p className="empty-quote">Select one or more applications to see the smallest safe server and exact fee split.</p>}
          </aside>
        </div>
      </section>

      <section className="bento" aria-label="Managed hosting benefits">
        <article className="bento-lead"><Globe weight="duotone" /><h2>Your software, reached through your domain.</h2><p>We register the hostname, show the exact CNAME, wait for verification, and issue the TLS certificate automatically.</p><div className="dns-row"><span>calendar.yourcompany.com</span><ArrowRight /><strong>workspace.hosted.example</strong></div></article>
        <article className="bento-small dark"><Gauge /><h3>Upgrade before the slowdown</h3><p>Move from 512 MB to 2 GB with one approval. Apps and domains stay in place.</p></article>
        <article className="bento-small blue"><Stack /><h3>One bill, fully explained</h3><p>Infrastructure, domains, and our fee stay separate on every invoice.</p></article>
      </section>

      <section className="self-host" id="self-host">
        <div className="self-host-intro"><span className="eyebrow">Google Cloud self-hosting</span><h2>A private Docker host in three deliberate steps.</h2><p>The open-source Terraform configuration creates the VM, disk, static address, and firewall. The dashboard then supplies DNS records and capacity guidance without taking ownership of your cloud account.</p></div>
        <div className="self-host-steps">
          <article><span>Prepare</span><h3>Create a Google Cloud project</h3><p>Enable billing, Compute Engine, and IAP. The free allowance is applied by Google when the account and region are eligible.</p><code>gcloud services enable compute.googleapis.com iap.googleapis.com</code></article>
          <article><span>Deploy</span><h3>Apply the open-source infrastructure</h3><p>Terraform provisions a Debian micro VM with Docker, a persistent disk, and ports 80 and 443.</p><code>terraform -chdir=infra/google-cloud apply</code></article>
          <article><span>Connect</span><h3>Point each tool at its domain</h3><p>Add the displayed A record or CNAME. Caddy routes each hostname and renews certificates automatically.</p><code>calendar.example.com → server address</code></article>
        </div>
        <div className="self-host-note"><strong>Capacity, not licence count, is the limit.</strong><span>The catalogue is unrestricted, but the dashboard prevents a 1 GB VM from starting more applications than it can run safely.</span></div>
      </section>

      <section className="process" id="how" ref={howRef}>
        <div className="process-heading"><span className="eyebrow">How it works</span><h2>Private infrastructure without infrastructure work.</h2></div>
        <div className="process-copy">
          <p>{"Choose open-source tools from a curated catalogue. We calculate whether they can safely share a server, generate their secrets, route each hostname, and keep enough memory in reserve. When usage grows, approve an upgrade and Render moves the server to a larger instance.".split(" ").map((word, index) => <span className="reveal-word" key={`${word}-${index}`}>{word} </span>)}</p>
          <div className="steps">
            <article><span>Choose</span><h3>Build a private stack</h3><p>Pick tools and see the real infrastructure cost before creating anything.</p></article>
            <article><span>Connect</span><h3>Point your domain</h3><p>Copy one DNS record while certificate status updates automatically.</p></article>
            <article><span>Grow</span><h3>Upgrade on demand</h3><p>Add memory, storage, or another isolated service only when the stack needs it.</p></article>
          </div>
        </div>
      </section>

      <section className="servers" id="servers">
        <div className="section-heading"><div><span className="eyebrow">Your servers</span><h2>Every tool from one calm dashboard.</h2></div></div>
        {notice && <div className="notice">{notice}</div>}
        {installations.length ? <div className="server-list">{installations.map((installation) => <button key={installation.id} onClick={() => setActiveInstallation(installation)}><HardDrives /><div><strong>{installation.name}</strong><span>{installation.appIds.length} tools · {installation.plan}</span></div><span className="server-state">{installation.state}</span><ArrowRight /></button>)}</div> : <div className="empty-servers"><Cloud /><p>Your planned and live servers will appear here.</p><a href="#catalog">Choose your first tools</a></div>}
        {activeInstallation && <div className="domain-manager"><div><Globe /><div><span>Custom domain and capacity</span><strong>{activeInstallation.name}</strong></div></div><label><input placeholder="tools.yourcompany.com" value={domain} onChange={(event) => setDomain(event.target.value)} /><button onClick={addDomain}>Connect domain</button></label>{activeInstallation.customDomains.map((item) => <div className="domain-item" key={item}><Check />{item}<button onClick={() => navigator.clipboard.writeText(activeInstallation.hostname)}><Copy /> Copy target</button></div>)}<div className="upgrade-row"><div><Gauge /><span>Current plan</span><strong>{activeInstallation.plan}</strong></div>{config.plans.filter((plan) => plan.id !== activeInstallation.plan).map((plan) => <button key={plan.id} onClick={() => upgradeServer(plan.id)}>Upgrade to {plan.id} · {money(plan.monthlyCents)}</button>)}</div></div>}
      </section>

      <footer><div><h2>Host it with us.<br />Or take the whole stack.</h2><a className="button light" href="#paths">Choose your path <ArrowRight /></a></div><div className="footer-bottom"><span>{config.productName}</span><span>Open-source control plane · Transparent infrastructure · Portable data and domains</span></div></footer>
    </main>
  );
}
