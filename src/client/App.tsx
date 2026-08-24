import { useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import {
  ArrowRight,
  CalendarBlank,
  ChartLineUp,
  Check,
  Cloud,
  Copy,
  CreditCard,
  Gauge,
  Globe,
  HardDrives,
  List,
  Lock,
  Plus,
  SignOut,
  Stack,
  Storefront,
  User,
  X,
} from "@phosphor-icons/react";
import type {
  AccountUser,
  BackupRecord,
  CatalogApp,
  DashboardData,
  HostnameOwnershipInstructions,
  Installation,
  Quote,
} from "../shared/types";
import {
  suitePlanAllows,
  type SuiteModuleDefinition,
  type SuiteRecord,
  type SuiteWorkspace,
  type SuiteWorkspaceRole,
} from "../shared/suite";
/*
 * Runtime plan checks deliberately share the same helper as the server. This
 * keeps the catalogue honest before a customer attempts an installation while
 * the API remains the authoritative enforcement boundary.
 */
import type { SuiteActionDefinition, SuiteActionInputJsonSchema, SuiteActionRequiredScope } from "../shared/suite-actions";
import type { SuiteUsage } from "../shared/suite-quotas";
import {
  buildSuiteActionInput,
  createSuiteActionDraft,
  suiteActionSchemaTypes,
  type SuiteActionDraft,
} from "./suite-action-input";

interface PublicConfig {
  productName: string;
  provisioningMode: "dry-run" | "live";
  persistence: "postgres" | "preview-memory";
  billingReady: boolean;
  stripePublishableKey?: string;
  platformFeePercent: number;
  platformFeeMinimumCents: number;
  plans: Array<{
    id: string;
    label: string;
    memoryMb: number;
    cpu: number;
    storageGb: number;
    maxServices: number;
    infrastructureMonthlyCents: number;
    monthlyCents: number;
  }>;
}

interface DashboardSuiteAction extends Omit<SuiteActionDefinition, "inputSchema" | "exampleInput" | "requiredScope"> {
  inputSchema: SuiteActionInputJsonSchema;
  exampleInput: Record<string, unknown>;
  requiredScope: SuiteActionRequiredScope;
  mcpTool: string;
}
interface DashboardSuiteDomain {
  id: string;
  domain: string;
  status: "awaiting-dns" | "verified" | "active";
  ownership: HostnameOwnershipInstructions;
  lastCheckedAt?: string;
}

const money = (cents: number) =>
  cents === 0
    ? "provider cost pending"
    : new Intl.NumberFormat("en-US", {
        style: "currency",
        currency: "USD",
      }).format(cents / 100);
const dataSize = (bytes: number) =>
  bytes >= 1024 ** 3
    ? `${(bytes / 1024 ** 3).toFixed(bytes >= 10 * 1024 ** 3 ? 0 : 1)} GB`
    : bytes >= 1024 ** 2
      ? `${(bytes / 1024 ** 2).toFixed(1)} MB`
      : `${bytes} B`;
const api = async <T,>(url: string, options?: RequestInit): Promise<T> => {
  const response = await fetch(url, options);
  const body = response.status === 204 ? null : await response.json();
  if (!response.ok) throw new Error(body?.error ?? "Request failed.");
  return body as T;
};

function useRoute() {
  const [path, setPath] = useState(window.location.pathname);
  useEffect(() => {
    const listener = () => setPath(window.location.pathname);
    window.addEventListener("popstate", listener);
    return () => window.removeEventListener("popstate", listener);
  }, []);
  const navigate = (next: string) => {
    window.history.pushState({}, "", next);
    setPath(next);
    window.scrollTo({ top: 0, behavior: "smooth" });
  };
  return { path, navigate };
}

export function App() {
  const { path, navigate } = useRoute();
  const [catalog, setCatalog] = useState<CatalogApp[]>([]);
  const [config, setConfig] = useState<PublicConfig>({
    productName: "Managed OSS Cloud",
    provisioningMode: "dry-run",
    persistence: "preview-memory",
    billingReady: false,
    platformFeePercent: 12,
    platformFeeMinimumCents: 200,
    plans: [],
  });
  const [user, setUser] = useState<AccountUser | null>(null);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    Promise.all([
      api<PublicConfig>("/api/config"),
      api<CatalogApp[]>("/api/catalog"),
      fetch("/api/me").then((response) =>
        response.ok ? response.json() : { user: null },
      ),
    ]).then(([nextConfig, nextCatalog, me]) => {
      setConfig(nextConfig);
      setCatalog(nextCatalog);
      setUser(me.user);
      setLoaded(true);
    });
  }, []);

  if (!loaded)
    return (
      <div className="loading-screen">
        <Stack weight="fill" />
        <span>Opening your workspace</span>
      </div>
    );
  if (path === "/login" || path === "/signup")
    return (
      <AuthPage
        mode={path === "/login" ? "login" : "signup"}
        config={config}
        navigate={navigate}
        onAuthenticated={setUser}
      />
    );
  if (path.startsWith("/dashboard"))
    return user ? (
      <Dashboard
        config={config}
        catalog={catalog}
        user={user}
        navigate={navigate}
        onLogout={() => setUser(null)}
      />
    ) : (
      <AuthPage
        mode="login"
        config={config}
        navigate={navigate}
        onAuthenticated={setUser}
      />
    );
  return (
    <Landing
      config={config}
      catalog={catalog}
      user={user}
      navigate={navigate}
    />
  );
}

function Brand({ name }: { name: string }) {
  return (
    <span className="brand">
      <span className="brand-mark">
        <Stack weight="fill" />
      </span>
      {name}
    </span>
  );
}

function Landing({
  config,
  catalog,
  user,
  navigate,
}: {
  config: PublicConfig;
  catalog: CatalogApp[];
  user: AccountUser | null;
  navigate: (path: string) => void;
}) {
  const [selected, setSelected] = useState<string[]>([]);
  const [quote, setQuote] = useState<Quote | null>(null);
  const [hostingPath, setHostingPath] = useState<"managed" | "self-hosted">(
    "managed",
  );
  const [testimonial, setTestimonial] = useState(0);
  const root = useRef<HTMLElement>(null);
  const testimonials = [
    [
      "I want my booking page and forms on our own domain without becoming a systems administrator.",
      "Asha",
      "Independent studio",
    ],
    [
      "The useful bit is seeing the server cost and management fee as separate numbers.",
      "Mateo",
      "Small agency",
    ],
    [
      "If we outgrow the managed option, we can take the same open stack into our cloud account.",
      "Inez",
      "Operations lead",
    ],
  ];

  useEffect(() => {
    const host = root.current;
    if (!host) return;
    const timers = [
      ...host.querySelectorAll<HTMLElement>(".hero-reveal,.hero-console"),
    ].map((element, index) =>
      window.setTimeout(
        () => element.classList.add("is-visible"),
        40 + index * 90,
      ),
    );
    const observer = new IntersectionObserver(
      (entries) =>
        entries.forEach((entry) =>
          entry.target.classList.toggle("is-visible", entry.isIntersecting),
        ),
      { threshold: 0.22, rootMargin: "0px 0px -8%" },
    );
    host
      .querySelectorAll(".stack-card")
      .forEach((card) => observer.observe(card));
    return () => {
      timers.forEach(window.clearTimeout);
      observer.disconnect();
    };
  }, []);

  useEffect(() => {
    if (!selected.length) return setQuote(null);
    api<Quote>("/api/quote", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ appIds: selected }),
    }).then(setQuote);
  }, [selected]);
  const selectedApps = useMemo(
    () => catalog.filter((item) => selected.includes(item.id)),
    [catalog, selected],
  );
  const toggle = (app: CatalogApp) =>
    app.status === "ready" &&
    setSelected((current) =>
      current.includes(app.id)
        ? current.filter((id) => id !== app.id)
        : [...current, app.id],
    );
  const begin = () => navigate(user ? "/dashboard/catalog" : "/signup");

  return (
    <main className="page-shell" ref={root}>
      <nav className="nav-wrap">
        <a href="#top">
          <Brand name={config.productName} />
        </a>
        <div className="nav-links">
          <a href="#catalog">Catalogue</a>
          <a href="#ownership">Ownership</a>
          <a href="#pricing">Pricing</a>
        </div>
        <div className="nav-user">
          {user ? (
            <button onClick={() => navigate("/dashboard")}>
              <User /> Dashboard
            </button>
          ) : (
            <>
              <button className="plain" onClick={() => navigate("/login")}>
                Log in
              </button>
              <button
                className="nav-action"
                onClick={() => navigate("/signup")}
              >
                Create account <ArrowRight />
              </button>
            </>
          )}
        </div>
      </nav>

      <section className="hero" id="top">
        <div className="hero-copy">
          <p className="hero-kicker hero-reveal">
            Open software. Managed simply.
          </p>
          <h1 className="hero-reveal">
            Your tools, on your{" "}
            <span className="inline-image" aria-hidden="true" /> own domain.
          </h1>
          <p className="hero-reveal">
            Install proven open-source alternatives to scheduling, email,
            signatures, forms, analytics, and monitoring. Pay for the server
            plus one visible management fee.
          </p>
          <div className="hero-actions hero-reveal">
            <button className="button primary" onClick={begin}>
              Build your workspace <ArrowRight />
            </button>
            <a className="button secondary" href="#ownership">
              See the ownership model
            </a>
          </div>
        </div>
        <div className="hero-console">
          <div className="console-bar">
            <span>Your private workspace</span>
            <span>
              <i /> Capacity healthy
            </span>
          </div>
          <div className="console-app featured">
            <CalendarBlank />
            <div>
              <strong>Scheduling</strong>
              <span>calendar.yourdomain.com</span>
            </div>
            <em>Ready</em>
          </div>
          <div className="console-grid">
            <div>
              <List />
              <span>Forms</span>
            </div>
            <div>
              <ChartLineUp />
              <span>Analytics</span>
            </div>
            <div>
              <HardDrives />
              <span>Monitoring</span>
            </div>
            <div className="console-add">
              <Plus />
              <span>Add a tool</span>
            </div>
          </div>
          <div className="console-meter">
            <div>
              <span>Micro server</span>
              <strong>682 MB available</strong>
            </div>
            <i>
              <b />
            </i>
          </div>
        </div>
      </section>

      <div className="marquee">
        <div>
          {[
            "Custom domains",
            "Automatic TLS",
            "Portable data",
            "Open source",
            "Transparent pricing",
            "Capacity controls",
            "Custom domains",
            "Automatic TLS",
          ].map((item, index) => (
            <span key={`${item}-${index}`}>{item}</span>
          ))}
        </div>
      </div>

      <section className="chapter paths" id="ownership">
        <div className="section-heading">
          <div>
            <h2>
              Convenience now.
              <br />
              Control forever.
            </h2>
          </div>
          <p>
            Start with one-click managed hosting or deploy the same control
            plane into Google Cloud. Your domain and application data stay
            portable.
          </p>
        </div>
        <div className="path-accordions">
          <article
            className={hostingPath === "managed" ? "active" : ""}
            onMouseEnter={() => setHostingPath("managed")}
          >
            <Cloud weight="duotone" />
            <div>
              <small>Managed</small>
              <h3>We operate the stack.</h3>
              <p>
                Accounts, claim-specific DNS instructions, TLS, backups, and capacity
                upgrades live in one dashboard.
              </p>
            </div>
            <ul>
              <li>
                <Check />
                One-click plans
              </li>
              <li>
                <Check />
                Itemized monthly pricing
              </li>
              <li>
                <Check />
                Export path retained
              </li>
            </ul>
            <button className="button primary" onClick={begin}>
              Use managed hosting
            </button>
          </article>
          <article
            className={hostingPath === "self-hosted" ? "active" : ""}
            onMouseEnter={() => setHostingPath("self-hosted")}
          >
            <HardDrives weight="duotone" />
            <div>
              <small>Self-hosted</small>
              <h3>You operate the stack.</h3>
              <p>
                Run the MIT-licensed control plane in your Google Cloud project
                and pay Google directly.
              </p>
            </div>
            <ul>
              <li>
                <Check />
                Terraform starter
              </li>
              <li>
                <Check />
                Private cloud account
              </li>
              <li>
                <Check />
                No platform lock-in
              </li>
            </ul>
            <a
              className="button secondary"
              href="https://github.com/rohanarun/managed-oss-cloud"
            >
              View source
            </a>
          </article>
        </div>
      </section>

      <section className="chapter catalog-section" id="catalog">
        <div className="section-heading">
          <div>
            <h2>
              Known software.
              <br />
              One calm catalogue.
            </h2>
          </div>
          <p>
            Versions and licenses are explicit. “Verification” means we are
            still testing deployment, backup, restore, or an external
            integration.
          </p>
        </div>
        <div className="catalog-layout">
          <div className="app-grid">
            {catalog.map((app) => {
              const selectedNow = selected.includes(app.id);
              return (
                <button
                  className={`app-card ${selectedNow ? "selected" : ""} ${app.status !== "ready" ? "pending" : ""}`}
                  key={app.id}
                  onClick={() => toggle(app)}
                >
                  <div className="app-card-head">
                    <span className="app-monogram">{app.name.slice(0, 1)}</span>
                    <span className="app-status">
                      {app.status === "ready" ? (
                        selectedNow ? (
                          <Check />
                        ) : (
                          <Plus />
                        )
                      ) : (
                        <Lock />
                      )}
                    </span>
                  </div>
                  <div>
                    <span className="category">
                      {app.category} · {app.license}
                    </span>
                    <h3>{app.name}</h3>
                    <p>{app.description}</p>
                  </div>
                  <div className="app-meta">
                    <span>Replaces {app.replaces}</span>
                    <span>{app.version}</span>
                  </div>
                  {app.status !== "ready" && (
                    <span className="verification-note">
                      Deployment verification in progress
                    </span>
                  )}
                </button>
              );
            })}
          </div>
          <aside className="quote-panel" id="pricing">
            <div className="quote-title">
              <Cloud />
              <div>
                <span>Workspace estimate</span>
                <strong>
                  {selected.length
                    ? `${selected.length} selected`
                    : "Choose plan-ready tools"}
                </strong>
              </div>
            </div>
            <div className="selected-list">
              {selectedApps.map((app) => (
                <div key={app.id}>
                  <span>{app.name}</span>
                  <button onClick={() => toggle(app)}>
                    <X />
                  </button>
                </div>
              ))}
            </div>
            {quote ? (
              <>
                <div className="quote-capacity">
                  <span>Planned memory</span>
                  <strong>{quote.requestedMemoryMb} MB</strong>
                </div>
                <p className="fit-note">{quote.explanation}</p>
                <div className="price-lines">
                  <div>
                    <span>Cloud infrastructure</span>
                    <span>{money(quote.infrastructureMonthlyCents)}</span>
                  </div>
                  <div>
                    <span>Management fee</span>
                    <span>{money(quote.platformFeeCents)}</span>
                  </div>
                  <div className="total">
                    <span>Estimated total</span>
                    <strong>{money(quote.totalMonthlyCents)}</strong>
                  </div>
                </div>
                <button className="button primary full" onClick={begin}>
                  Continue in dashboard <ArrowRight />
                </button>
              </>
            ) : (
              <p className="empty-quote">
                Select a plan-ready tool to calculate capacity. Google Cloud
                prices remain unquoted until the owning project and region are
                confirmed.
              </p>
            )}
          </aside>
        </div>
      </section>

      <section className="bento" aria-label="Hosting capabilities">
        <article className="bento-lead">
          <Globe />
          <h2>Share every tool through your domain.</h2>
          <p>
            Copy the claim-specific TXT or CNAME proof, then watch verification
            status without treating a shared platform IP as ownership.
          </p>
          <div className="dns-row">
            <span>calendar.company.com</span>
            <ArrowRight />
            <strong>unique-claim.verify.apps.example.com</strong>
          </div>
        </article>
        <article className="bento-small dark">
          <Gauge />
          <h3>Capacity before guesswork</h3>
          <p>
            Apps are admitted only when the server retains a safety reserve.
          </p>
        </article>
        <article className="bento-small blue">
          <CreditCard />
          <h3>One fee, separately shown</h3>
          <p>
            Infrastructure and our management fee never become one mystery line.
          </p>
        </article>
      </section>

      <section className="process chapter">
        <div className="process-heading">
          <h2>A server that grows one deliberate step at a time.</h2>
        </div>
        <div className="process-copy">
          <article className="stack-card">
            <span>Choose</span>
            <h3>Build the smallest safe stack</h3>
            <p>
              Select verified apps and see which machine can hold them without
              exhausting memory.
            </p>
          </article>
          <article className="stack-card">
            <span>Connect</span>
            <h3>Use a domain people recognize</h3>
            <p>
              Add the exact TXT or CNAME proof from the dashboard. Certificate
              work starts only after ownership is verified.
            </p>
          </article>
          <article className="stack-card">
            <span>Grow</span>
            <h3>Approve a larger machine</h3>
            <p>
              The dashboard preserves apps and hostnames while the provider
              upgrade is reconciled.
            </p>
          </article>
        </div>
      </section>

      <section className="testimonials chapter">
        <div>
          <h2>Built for people who want ownership without a second job.</h2>
          <div className="testimonial-controls">
            <button onClick={() => setTestimonial((testimonial + 2) % 3)}>
              ←
            </button>
            <button onClick={() => setTestimonial((testimonial + 1) % 3)}>
              →
            </button>
          </div>
        </div>
        <blockquote>
          <p>“{testimonials[testimonial][0]}”</p>
          <footer>
            <strong>{testimonials[testimonial][1]}</strong>
            <span>{testimonials[testimonial][2]}</span>
          </footer>
        </blockquote>
      </section>

      <footer className="site-footer">
        <div>
          <h2>
            Put your daily tools
            <br />
            under one roof.
          </h2>
          <button className="button light" onClick={begin}>
            Create your workspace <ArrowRight />
          </button>
        </div>
        <div className="footer-bottom">
          <Brand name={config.productName} />
          <span>
            Open-source control plane · Portable infrastructure · Transparent
            fees
          </span>
        </div>
      </footer>
    </main>
  );
}

function AuthPage({
  mode,
  config,
  navigate,
  onAuthenticated,
}: {
  mode: "login" | "signup";
  config: PublicConfig;
  navigate: (path: string) => void;
  onAuthenticated: (user: AccountUser) => void;
}) {
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setError("");
    const data = new FormData(event.currentTarget);
    try {
      const result = await api<{ user: AccountUser }>(
        `/api/auth/${mode === "signup" ? "signup" : "login"}`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            displayName: data.get("displayName"),
            email: data.get("email"),
            password: data.get("password"),
          }),
        },
      );
      onAuthenticated(result.user);
      navigate("/dashboard");
    } catch (nextError) {
      setError(
        nextError instanceof Error ? nextError.message : "Could not continue.",
      );
    } finally {
      setBusy(false);
    }
  }
  return (
    <main className="auth-shell">
      <section className="auth-story">
        <button className="back-link" onClick={() => navigate("/")}>
          ← Back to site
        </button>
        <Brand name={config.productName} />
        <h1>Your private software workspace starts here.</h1>
        <p>
          Use one account to install tools, connect domains, see capacity, and
          approve upgrades.
        </p>
        <div className="auth-proof">
          <Lock />
          <span>
            Passwords use salted scrypt hashes. Sessions stay in secure,
            HTTP-only cookies.
          </span>
        </div>
      </section>
      <section className="auth-panel">
        <form onSubmit={submit}>
          <span>
            {mode === "signup" ? "Create your account" : "Welcome back"}
          </span>
          <h2>
            {mode === "signup"
              ? "Build your workspace"
              : "Log in to your dashboard"}
          </h2>
          {mode === "signup" && (
            <label>
              Name
              <input
                name="displayName"
                autoComplete="name"
                required
                minLength={2}
              />
            </label>
          )}
          <label>
            Email
            <input name="email" type="email" autoComplete="email" required />
          </label>
          <label>
            Password
            <input
              name="password"
              type="password"
              autoComplete={
                mode === "signup" ? "new-password" : "current-password"
              }
              required
              minLength={mode === "signup" ? 10 : 1}
            />
          </label>
          {error && <p className="form-error">{error}</p>}
          <button className="button primary full" disabled={busy}>
            {busy
              ? "Working…"
              : mode === "signup"
                ? "Create account"
                : "Log in"}
            <ArrowRight />
          </button>
          <p>
            {mode === "signup"
              ? "Already have an account?"
              : "Need an account?"}{" "}
            <button
              type="button"
              onClick={() => navigate(mode === "signup" ? "/login" : "/signup")}
            >
              {mode === "signup" ? "Log in" : "Sign up"}
            </button>
          </p>
          {config.persistence === "preview-memory" && (
            <div className="preview-warning">
              Preview mode: accounts reset when this demo restarts. PostgreSQL
              enables durable accounts.
            </div>
          )}
        </form>
      </section>
    </main>
  );
}

function Dashboard({
  config,
  catalog,
  user,
  navigate,
  onLogout,
}: {
  config: PublicConfig;
  catalog: CatalogApp[];
  user: AccountUser;
  navigate: (path: string) => void;
  onLogout: () => void;
}) {
  const suitePlanLabel = (planId: string) => {
    const plan = config.plans.find((candidate) => candidate.id === planId);
    if (!plan) return planId;
    const price = new Intl.NumberFormat("en-US", {
      style: "currency",
      currency: "USD",
      maximumFractionDigits: plan.monthlyCents % 100 === 0 ? 0 : 2,
    }).format(plan.monthlyCents / 100);
    return `${price} ${plan.label}`;
  };
  const [data, setData] = useState<DashboardData | null>(null);
  const [suite, setSuite] = useState<{
    workspace: SuiteWorkspace;
    modules: SuiteModuleDefinition[];
  } | null>(null);
  const [suiteUsage, setSuiteUsage] = useState<SuiteUsage | null>(null);
  const [suiteActions, setSuiteActions] = useState<DashboardSuiteAction[]>([]);
  const [activeSuiteModule, setActiveSuiteModule] =
    useState<SuiteModuleDefinition | null>(null);
  const [activeSuiteAction, setActiveSuiteAction] =
    useState<DashboardSuiteAction | null>(null);
  const [suiteActionDraft, setSuiteActionDraft] = useState<SuiteActionDraft>({});
  const [suiteRecords, setSuiteRecords] = useState<SuiteRecord[]>([]);
  const [suiteActionBusy, setSuiteActionBusy] = useState(false);
  const [suiteMembers, setSuiteMembers] = useState<
    Array<{
      userId: string;
      role: SuiteWorkspaceRole;
      email?: string;
      displayName?: string;
    }>
  >([]);
  const [suiteDomains, setSuiteDomains] = useState<DashboardSuiteDomain[]>([]);
  const [suiteDomain, setSuiteDomain] = useState("");
  const [memberEmail, setMemberEmail] = useState("");
  const [memberRole, setMemberRole] =
    useState<Exclude<SuiteWorkspaceRole, "owner">>("member");
  const [apiToken, setApiToken] = useState("");
  const [section, setSection] = useState(
    window.location.pathname.split("/")[2] || "overview",
  );
  const [selected, setSelected] = useState<string[]>([]);
  const [serverName, setServerName] = useState("my-workspace");
  const [selectedPlan, setSelectedPlan] = useState("starter");
  const [active, setActive] = useState<Installation | null>(null);
  const [domain, setDomain] = useState("");
  const [cloneAppId, setCloneAppId] = useState("uptime-kuma");
  const [backups, setBackups] = useState<BackupRecord[]>([]);
  const [notice, setNotice] = useState("");
  const load = () =>
    Promise.all([
      api<DashboardData>("/api/dashboard").then(setData),
      api<{ workspace: SuiteWorkspace; modules: SuiteModuleDefinition[] }>(
        "/api/suite/workspace",
      ).then(setSuite),
      api<{ usage: SuiteUsage }>("/api/suite/usage").then((result) =>
        setSuiteUsage(result.usage),
      ),
      api<{
        members: Array<{
          userId: string;
          role: SuiteWorkspaceRole;
          email?: string;
          displayName?: string;
        }>;
      }>("/api/suite/members").then((result) =>
        setSuiteMembers(result.members),
      ),
      api<{ domains: DashboardSuiteDomain[] }>(
        "/api/suite/domains",
      ).then((result) => {
        setSuiteDomains(result.domains);
      }),
      api<DashboardSuiteAction[]>("/api/suite/actions").then(setSuiteActions),
    ]);
  useEffect(() => {
    void load();
  }, []);
  const go = (next: string) => {
    setSection(next);
    window.history.pushState(
      {},
      "",
      `/dashboard/${next === "overview" ? "" : next}`,
    );
  };
  async function createPlan(input?: { appIds?: string[]; plan?: string; nextSection?: "servers" | "billing" }) {
    try {
      const appIds = input?.appIds ?? selected;
      const plan = input?.plan ?? selectedPlan;
      const result = await api<{ installation: Installation }>(
        "/api/installations",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ appIds, name: serverName, plan }),
        },
      );
      setActive(result.installation);
      setNotice(
        config.billingReady
          ? "Server plan saved. Review it, then continue to secure checkout."
          : "Server plan saved. Checkout remains locked until production billing is verified.",
      );
      setSelected([]);
      await load();
      go(input?.nextSection ?? "servers");
    } catch (error) {
      setNotice(
        error instanceof Error ? error.message : "Could not save plan.",
      );
    }
  }
  async function addDomain() {
    if (!active) return;
    try {
      const result = await api<{
        installation: Installation;
        dns: HostnameOwnershipInstructions;
      }>(`/api/installations/${active.id}/domains`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ domain }),
      });
      setActive(result.installation);
      setDomain("");
      setNotice(`Publish either TXT ${result.dns.txt.name} = ${result.dns.txt.value}, or the exact CNAME ${result.dns.cname.name} to ${result.dns.cname.value}.`);
      await load();
    } catch (error) {
      setNotice(
        error instanceof Error ? error.message : "Could not add domain.",
      );
    }
  }
  async function upgrade(plan: string) {
    if (!active) return;
    try {
      const result = await api<{ installation: Installation }>(
        `/api/installations/${active.id}/upgrade`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ plan }),
        },
      );
      setActive(result.installation);
      setNotice(
        `Upgrade to ${plan} saved and reconciled with billing when required.`,
      );
      await load();
    } catch (error) {
      setNotice(
        error instanceof Error ? error.message : "Could not plan upgrade.",
      );
    }
  }
  async function cloneService() {
    if (!active) return;
    try {
      await api(`/api/installations/${active.id}/applications`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "Idempotency-Key": crypto.randomUUID() },
        body: JSON.stringify({ appId: cloneAppId }),
      });
      const refreshed = await api<DashboardData>("/api/dashboard");
      setData(refreshed);
      setActive(
        refreshed.installations.find((item) => item.id === active.id) ?? active,
      );
      setNotice(
        "Service clone reserved. It will receive its own hostname, containers, and persistent storage.",
      );
    } catch (error) {
      setNotice(
        error instanceof Error ? error.message : "Could not clone service.",
      );
    }
  }
  async function verifyDomainName(name: string) {
    if (!active) return;
    try {
      const result = await api<{ method: string; expected: string }>(
        `/api/installations/${active.id}/domains/${encodeURIComponent(name)}/verify`,
        { method: "POST" },
      );
      setNotice(
        `${name} verified by ${result.method}. TLS routing is now queued.`,
      );
      await load();
    } catch (error) {
      setNotice(
        error instanceof Error ? error.message : "DNS is not ready yet.",
      );
    }
  }
  async function manageApplication(
    applicationInstanceId: string,
    action: "start" | "stop" | "backup" | "restore",
    objectName?: string,
  ) {
    if (!active) return;
    try {
      await api(`/api/installations/${active.id}/actions`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action, applicationInstanceId, objectName }),
      });
      setNotice(
        `${action[0].toUpperCase() + action.slice(1)} queued for this application.`,
      );
      if (action === "backup" || action === "restore")
        setTimeout(() => {
          void api<BackupRecord[]>(
            `/api/installations/${active.id}/backups`,
          ).then(setBackups);
        }, 2500);
      await load();
    } catch (error) {
      setNotice(
        error instanceof Error
          ? error.message
          : `Could not ${action} application.`,
      );
    }
  }
  async function startCheckout() {
    if (!active) return setNotice("Select a planned server before checkout.");
    try {
      const result = await api<{ url: string | null }>(
        "/api/billing/checkout",
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Idempotency-Key": `checkout:${active.id}:${crypto.randomUUID()}`,
          },
          body: JSON.stringify({ installationId: active.id }),
        },
      );
      if (!result.url) throw new Error("Stripe did not return a checkout URL.");
      window.location.assign(result.url);
    } catch (error) {
      setNotice(
        error instanceof Error ? error.message : "Checkout could not start.",
      );
    }
  }
  async function enableSuiteModule(module: SuiteModuleDefinition) {
    try {
      const result = await api<{ workspace: SuiteWorkspace }>(
        `/api/suite/modules/${module.id}/enable`,
        { method: "POST" },
      );
      setSuite((current) =>
        current ? { ...current, workspace: result.workspace } : current,
      );
      setNotice(
        `${module.name} is enabled and shares this workspace database.`,
      );
    } catch (error) {
      setNotice(
        error instanceof Error
          ? error.message
          : "Could not enable this module.",
      );
    }
  }
  function chooseSuiteAction(action: DashboardSuiteAction) {
    setActiveSuiteAction(action);
    setSuiteActionDraft(createSuiteActionDraft(action));
  }
  async function openSuiteModule(module: SuiteModuleDefinition) {
    setActiveSuiteModule(module);
    const moduleActions = suiteActions.filter(
      (action) => action.moduleId === module.id,
    );
    if (moduleActions[0]) chooseSuiteAction(moduleActions[0]);
    try {
      const result = await api<{ records: SuiteRecord[] }>(
        `/api/suite/records?moduleId=${encodeURIComponent(module.id)}&limit=100`,
      );
      setSuiteRecords(result.records);
    } catch (error) {
      setNotice(
        error instanceof Error ? error.message : "Could not open this module.",
      );
    }
  }
  async function runSuiteAction() {
    if (!activeSuiteModule || !activeSuiteAction) return;
    setSuiteActionBusy(true);
    try {
      const input = buildSuiteActionInput(activeSuiteAction, suiteActionDraft);
      const result = await api<{ kind: string }>(
        `/api/suite/modules/${activeSuiteModule.id}/actions/${activeSuiteAction.id}`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ input }),
        },
      );
      const records = await api<{ records: SuiteRecord[] }>(
        `/api/suite/records?moduleId=${encodeURIComponent(activeSuiteModule.id)}&limit=100`,
      );
      setSuiteRecords(records.records);
      const usage = await api<{ usage: SuiteUsage }>("/api/suite/usage");
      setSuiteUsage(usage.usage);
      setNotice(
        result.kind === "ai-action"
          ? `${activeSuiteAction.title} was queued for the private AI worker.`
          : `${activeSuiteAction.title} completed.`,
      );
    } catch (error) {
      setNotice(
        error instanceof Error
          ? error.message
          : "The workflow action could not run.",
      );
    } finally {
      setSuiteActionBusy(false);
    }
  }
  async function createSuiteToken() {
    try {
      const result = await api<{ token: { token: string } }>(
        "/api/suite/api-tokens",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            name: `Dashboard token ${new Date().toISOString().slice(0, 10)}`,
          }),
        },
      );
      setApiToken(result.token.token);
      setNotice(
        "CLI and MCP token created. Copy it now; it will not be shown again.",
      );
    } catch (error) {
      setNotice(
        error instanceof Error
          ? error.message
          : "Could not create an API token.",
      );
    }
  }
  async function addSuiteMember() {
    try {
      const result = await api<{
        member: {
          userId: string;
          role: SuiteWorkspaceRole;
          email?: string;
          displayName?: string;
        };
      }>("/api/suite/members", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: memberEmail, role: memberRole }),
      });
      setSuiteMembers((members) => [...members, result.member]);
      setMemberEmail("");
      setNotice(
        `${result.member.email ?? "The account"} now shares this customer workspace.`,
      );
    } catch (error) {
      setNotice(
        error instanceof Error
          ? error.message
          : "Could not add this workspace member.",
      );
    }
  }
  async function removeSuiteMember(userId: string) {
    try {
      await api(`/api/suite/members/${userId}`, { method: "DELETE" });
      setSuiteMembers((members) =>
        members.filter((member) => member.userId !== userId),
      );
      setNotice("Workspace access removed.");
    } catch (error) {
      setNotice(
        error instanceof Error
          ? error.message
          : "Could not remove this workspace member.",
      );
    }
  }
  async function addSuiteDomain() {
    try {
      const result = await api<{
        domain: DashboardSuiteDomain;
        dns: HostnameOwnershipInstructions;
      }>("/api/suite/domains", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ domain: suiteDomain }),
      });
      setSuiteDomains((domains) => [...domains, result.domain]);
      setSuiteDomain("");
      setNotice(`Publish either TXT ${result.dns.txt.name} = ${result.dns.txt.value}, or the exact CNAME ${result.dns.cname.name} to ${result.dns.cname.value}.`);
    } catch (error) {
      setNotice(
        error instanceof Error
          ? error.message
          : "Could not add this suite domain.",
      );
    }
  }
  async function verifySuiteDomain(name: string) {
    try {
      const result = await api<{
        domain: DashboardSuiteDomain;
        method: string;
      }>(`/api/suite/domains/${encodeURIComponent(name)}/verify`, {
        method: "POST",
      });
      setSuiteDomains((domains) =>
        domains.map((domain) =>
          domain.id === result.domain.id ? result.domain : domain,
        ),
      );
      setNotice(
        `${name} is verified by ${result.method}; TLS routing is being reconciled.`,
      );
    } catch (error) {
      setNotice(
        error instanceof Error ? error.message : "DNS is not ready yet.",
      );
    }
  }
  async function logout() {
    await api("/api/auth/logout", { method: "POST" });
    onLogout();
    navigate("/");
  }
  const installations = data?.installations ?? [];
  const usedMemory =
    active?.applications?.reduce(
      (sum, app) => sum + app.memoryReservationMb,
      0,
    ) ?? 0;
  const usedStorage =
    active?.applications?.reduce(
      (sum, app) => sum + app.storageReservationGb,
      0,
    ) ?? 0;
  const currentPlan = active
    ? config.plans.find((plan) => plan.id === active.plan)
    : undefined;
  useEffect(() => {
    if (!active) return setBackups([]);
    void api<BackupRecord[]>(`/api/installations/${active.id}/backups`)
      .then(setBackups)
      .catch(() => setBackups([]));
  }, [active?.id]);
  return (
    <main className="dashboard-shell">
      <aside className="dashboard-sidebar">
        <button className="dashboard-brand" onClick={() => navigate("/")}>
          <Brand name={config.productName} />
        </button>
        <nav>
          {[
            ["overview", Gauge, "Overview"],
            ["suite", Stack, "AI Suite"],
            ["catalog", Storefront, "Catalogue"],
            ["servers", HardDrives, "Servers"],
            ["domains", Globe, "Domains"],
            ["billing", CreditCard, "Billing"],
          ].map(([id, Icon, label]) => (
            <button
              key={String(id)}
              className={section === id ? "active" : ""}
              onClick={() => go(String(id))}
            >
              <Icon />
              {String(label)}
            </button>
          ))}
        </nav>
        <div className="account-card">
          <span>{user.displayName.slice(0, 1).toUpperCase()}</span>
          <div>
            <strong>{user.displayName}</strong>
            <small>{user.email}</small>
          </div>
          <button onClick={logout}>
            <SignOut />
          </button>
        </div>
      </aside>
      <section className="dashboard-main">
        <header>
          <div>
            <span>Workspace control plane</span>
            <h1>
              {section === "overview"
                ? `Good to see you, ${user.displayName.split(" ")[0]}.`
                : section === "suite"
                  ? "AI-native business suite"
                  : section[0].toUpperCase() + section.slice(1)}
            </h1>
          </div>
          <button className="button primary" onClick={() => go("suite")}>
            <Plus /> Enable a module
          </button>
        </header>
        {notice && (
          <div className="notice">
            {notice}
            <button onClick={() => setNotice("")}>
              <X />
            </button>
          </div>
        )}
        {section === "overview" && (
          <>
            <div className="metric-grid">
              <article>
                <span>Servers</span>
                <strong>{installations.length}</strong>
                <small>
                  {installations.filter((item) => item.state === "live").length}{" "}
                  live
                </small>
              </article>
              <article>
                <span>Installed tools</span>
                <strong>
                  {installations.reduce(
                    (total, item) => total + item.appIds.length,
                    0,
                  )}
                </strong>
                <small>Across all servers</small>
              </article>
              <article>
                <span>Custom domains</span>
                <strong>
                  {installations.reduce(
                    (total, item) => total + item.customDomains.length,
                    0,
                  )}
                </strong>
                <small>Awaiting DNS or active</small>
              </article>
            </div>
            <div className="dashboard-banner">
              <div>
                <Cloud />
                <span>Provisioning mode</span>
                <strong>
                  {config.provisioningMode === "dry-run"
                    ? "Safe planning only"
                    : "Live"}
                </strong>
              </div>
              <p>
                No cloud resource or charge is created while billing and
                provider reconciliation are locked.
              </p>
            </div>
            <ServerTable
              installations={installations}
              catalog={catalog}
              onSelect={(item) => {
                setActive(item);
                go("servers");
              }}
            />
          </>
        )}
        {section === "suite" && suite && (
          <div className="suite-page">
            <div className="suite-intro">
              <div>
                <span>
                  Shared customer database ·{" "}
                  {suite.workspace.currentRole ?? "member"}
                </span>
                <h2>
                  {suite.workspace.enabledModuleIds.length} of{" "}
                  {suite.modules.length} modules enabled
                </h2>
                <p>
                  Every module uses the same workspace records and event stream
                  while customer workspaces remain isolated. Your current plan
                  is{" "}
                  <strong>
                    {suite.workspace.plan === "none"
                      ? "not active"
                      : suitePlanLabel(suite.workspace.plan)}
                  </strong>
                  .
                </p>
                {suiteUsage && (
                  <div className="suite-usage">
                    <div>
                      <strong>{suiteUsage.recordCount.toLocaleString()}</strong>
                      <span>
                        of {suiteUsage.recordLimit.toLocaleString()} records
                      </span>
                    </div>
                    <div>
                      <strong>
                        {suiteUsage.aiActionsThisMonth.toLocaleString()}
                      </strong>
                      <span>
                        of {suiteUsage.aiActionLimit.toLocaleString()} AI
                        actions this month
                      </span>
                    </div>
                    <div>
                      <strong>
                        {dataSize(suiteUsage.registeredStorageBytes)}
                      </strong>
                      <span>
                        of {dataSize(suiteUsage.storageLimitBytes)} registered
                        storage
                      </span>
                    </div>
                  </div>
                )}
                {suite.workspace.plan === "none" && (
                  <div className="suite-plan-selector">
                    <strong>Activate the shared suite first</strong>
                    <p>
                      Start with zero external apps. Every enabled module shares
                      this customer database, and services can be cloned into
                      the allocation later.
                    </p>
                    <label>
                      Workspace name
                      <input
                        value={serverName}
                        onChange={(event) => setServerName(event.target.value)}
                      />
                    </label>
                    <div className="plan-buttons">
                      {config.plans.map((plan) => (
                        <button
                          key={plan.id}
                          onClick={() => void createPlan({ appIds: [], plan: plan.id, nextSection: "billing" })}
                        >
                          <strong>{plan.label} · {money(plan.monthlyCents)}</strong>
                          <span>
                            {plan.storageGb} GB registered storage · {plan.maxServices} optional services
                          </span>
                        </button>
                      ))}
                    </div>
                  </div>
                )}
              </div>
              <div className="suite-access">
                <strong>CLI and MCP access</strong>
                <code>supersuite actions</code>
                <code>supersuite-mcp</code>
                {apiToken ? (
                  <button
                    onClick={() => navigator.clipboard.writeText(apiToken)}
                  >
                    <Copy /> Copy one-time token
                  </button>
                ) : (
                  <button onClick={createSuiteToken}>Create API token</button>
                )}
              </div>
            </div>
            <section className="suite-team">
              <div>
                <span>Customer workspace access</span>
                <h3>One customer, one shared database</h3>
                <p>
                  Members work across enabled tools. Viewers remain read-only;
                  admins can install modules and manage access.
                </p>
              </div>
              <div className="suite-member-form">
                <input
                  type="email"
                  placeholder="teammate@company.com"
                  value={memberEmail}
                  onChange={(event) => setMemberEmail(event.target.value)}
                />
                <select
                  value={memberRole}
                  onChange={(event) =>
                    setMemberRole(
                      event.target.value as Exclude<
                        SuiteWorkspaceRole,
                        "owner"
                      >,
                    )
                  }
                >
                  <option value="member">Member</option>
                  <option value="viewer">Viewer</option>
                  <option value="admin">Admin</option>
                </select>
                <button
                  disabled={
                    !memberEmail ||
                    !["owner", "admin"].includes(
                      suite.workspace.currentRole ?? "",
                    )
                  }
                  onClick={addSuiteMember}
                >
                  <Plus /> Add account
                </button>
              </div>
              <div className="suite-member-list">
                {suiteMembers.map((member) => (
                  <div key={member.userId}>
                    <span>
                      {member.displayName?.slice(0, 1).toUpperCase() ?? "U"}
                    </span>
                    <div>
                      <strong>
                        {member.displayName ?? member.email ?? member.userId}
                      </strong>
                      <small>{member.email}</small>
                    </div>
                    <em>{member.role}</em>
                    {member.role !== "owner" &&
                      ["owner", "admin"].includes(
                        suite.workspace.currentRole ?? "",
                      ) && (
                        <button
                          onClick={() => removeSuiteMember(member.userId)}
                        >
                          Remove
                        </button>
                      )}
                  </div>
                ))}
              </div>
            </section>
            {activeSuiteModule && (
              <section className="suite-workbench">
                <header>
                  <div>
                    <span>{activeSuiteModule.category}</span>
                    <h3>{activeSuiteModule.name}</h3>
                    <p>{activeSuiteModule.description}</p>
                  </div>
                  <button onClick={() => setActiveSuiteModule(null)}>
                    <X /> Close
                  </button>
                </header>
                <div className="suite-workbench-grid">
                  <nav>
                    {suiteActions
                      .filter(
                        (action) => action.moduleId === activeSuiteModule.id,
                      )
                      .map((action) => (
                        <button
                          key={action.id}
                          className={
                            activeSuiteAction?.id === action.id ? "active" : ""
                          }
                          onClick={() => chooseSuiteAction(action)}
                        >
                          <strong>{action.title}</strong>
                          <span>
                            {action.requiredScope} · {action.mcpTool}
                          </span>
                        </button>
                      ))}
                  </nav>
                  {activeSuiteAction && (
                    <form
                      onSubmit={(event) => {
                        event.preventDefault();
                        void runSuiteAction();
                      }}
                    >
                      <div>
                        <span>Run typed workflow</span>
                        <h4>{activeSuiteAction.title}</h4>
                        <p>{activeSuiteAction.description}</p>
                      </div>
                      {Object.entries(
                        activeSuiteAction.inputSchema.properties,
                      ).map(([field, schema]) => {
                        const schemaTypes = suiteActionSchemaTypes(schema);
                        const required = activeSuiteAction.inputSchema.required.includes(field);
                        const choices = Array.isArray(schema.enum)
                          ? schema.enum.filter((choice): choice is string => typeof choice === "string")
                          : [];
                        return (
                          <label key={field}>
                            {field}{" "}
                            <small>{required ? "Required" : "Optional"}</small>
                          {schemaTypes.includes("boolean") ? (
                            <input
                              type="checkbox"
                              checked={suiteActionDraft[field] === true}
                              onChange={(event) =>
                                setSuiteActionDraft((draft) => ({
                                  ...draft,
                                  [field]: event.target.checked,
                                }))
                              }
                            />
                          ) : choices.length > 0 ? (
                            <select
                              value={String(suiteActionDraft[field] ?? "")}
                              onChange={(event) =>
                                setSuiteActionDraft((draft) => ({
                                  ...draft,
                                  [field]: event.target.value,
                                }))
                              }
                            >
                              {!required && <option value="">Not set</option>}
                              {choices.map((choice) => (
                                <option key={choice} value={choice}>{choice}</option>
                              ))}
                            </select>
                          ) : schemaTypes.includes("array") ||
                            schemaTypes.includes("object") ? (
                            <textarea
                              value={String(suiteActionDraft[field] ?? "")}
                              onChange={(event) =>
                                setSuiteActionDraft((draft) => ({
                                  ...draft,
                                  [field]: event.target.value,
                                }))
                              }
                            />
                          ) : (
                            <input
                              type={
                                schemaTypes.includes("integer") ||
                                schemaTypes.includes("number")
                                  ? "number"
                                  : schema.format === "email"
                                  ? "email"
                                  : schema.format === "uri"
                                    ? "url"
                                    : "text"
                              }
                              value={String(suiteActionDraft[field] ?? "")}
                              onChange={(event) =>
                                setSuiteActionDraft((draft) => ({
                                  ...draft,
                                  [field]: event.target.value,
                                }))
                              }
                            />
                          )}
                            <small>
                              {typeof schema.description === "string"
                                ? schema.description
                                : ""}
                            </small>
                          </label>
                        );
                      })}
                      <button
                        className="button primary"
                        disabled={
                          suiteActionBusy ||
                          suite.workspace.currentRole === "viewer"
                        }
                      >
                        {suiteActionBusy
                          ? "Running…"
                          : activeSuiteAction.operation === "ai"
                            ? "Queue private AI action"
                            : "Run action"}
                      </button>
                    </form>
                  )}
                  <div className="suite-records">
                    <div>
                      <strong>Workspace records</strong>
                      <span>{suiteRecords.length} in this module</span>
                    </div>
                    {suiteRecords.length ? (
                      suiteRecords.map((record) => (
                        <article key={record.id}>
                          <span>{record.recordType}</span>
                          <strong>{record.title}</strong>
                          <small>
                            {record.state} · updated{" "}
                            {new Date(record.updatedAt).toLocaleString()}
                          </small>
                        </article>
                      ))
                    ) : (
                      <p>
                        No records yet. Run a workflow action to create the
                        first one.
                      </p>
                    )}
                  </div>
                </div>
              </section>
            )}
            <div className="suite-module-grid">
              {suite.modules.map((module) => {
                const enabled = suite.workspace.enabledModuleIds.includes(
                  module.id,
                );
                const allowed = suitePlanAllows(suite.workspace.plan, module);
                return (
                  <article key={module.id} className={enabled ? "enabled" : ""}>
                    <header>
                      <span>{module.category}</span>
                      <strong>
                        {module.minPlan === "starter"
                          ? "$7"
                          : module.minPlan === "scale"
                            ? "$50"
                            : "$200"}
                      </strong>
                    </header>
                    <h3>{module.name}</h3>
                    <small>
                      Original MIT implementation for {module.category.toLowerCase()} workflows
                    </small>
                    <p>{module.description}</p>
                    <div className="suite-tags">
                      {module.aiCapabilities.slice(0, 2).map((capability) => (
                        <span key={capability}>{capability}</span>
                      ))}
                    </div>
                    <footer>
                      <code>{module.id}_*</code>
                      <button
                        disabled={
                          !enabled &&
                          !["owner", "admin"].includes(
                            suite.workspace.currentRole ?? "",
                          )
                        }
                        onClick={() =>
                          enabled && allowed
                            ? void openSuiteModule(module)
                            : allowed
                              ? void enableSuiteModule(module)
                              : navigate("/dashboard/billing")
                        }
                      >
                        {enabled && allowed
                          ? "Open"
                          : allowed
                            ? "Enable"
                            : `Upgrade to ${suitePlanLabel(module.minPlan)}`}
                      </button>
                    </footer>
                  </article>
                );
              })}
            </div>
          </div>
        )}
        {section === "suite" && suite && (
          <section className="suite-domains">
            <div>
              <span>First-party custom domains</span>
              <h3>Share pages, links, and QR routes on your brand</h3>
              <p>
                Every hostname receives its own ownership proof. Use its TXT
                record for apex domains, or its exact one-time CNAME target.
                Verified hosts receive automatic TLS and route directly to this
                shared workspace.
              </p>
            </div>
            <div className="suite-domain-form">
              <input
                placeholder="links.company.com"
                value={suiteDomain}
                onChange={(event) => setSuiteDomain(event.target.value)}
              />
              <button
                disabled={
                  !suiteDomain ||
                  suite.workspace.plan === "none" ||
                  !["owner", "admin"].includes(
                    suite.workspace.currentRole ?? "",
                  )
                }
                onClick={addSuiteDomain}
              >
                <Plus /> Add domain
              </button>
              {suite.workspace.plan === "none" && (
                <small>
                  Activate {suitePlanLabel("starter")} to publish custom
                  domains.
                </small>
              )}
            </div>
            <div className="suite-domain-list">
              {suiteDomains.map((item) => (
                <div key={item.id}>
                  <span>
                    <i />
                    {item.domain}
                  </span>
                  <em>{item.status}</em>
                  <button
                    onClick={() =>
                      navigator.clipboard.writeText(
                        `${item.ownership.txt.name} TXT ${item.ownership.txt.value}`,
                      )
                    }
                  >
                    <Copy /> TXT proof
                  </button>
                  <button
                    onClick={() =>
                      navigator.clipboard.writeText(
                        `${item.ownership.cname.name} CNAME ${item.ownership.cname.value}`,
                      )
                    }
                  >
                    <Copy /> CNAME proof
                  </button>
                  <button onClick={() => verifySuiteDomain(item.domain)}>
                    Verify DNS
                  </button>
                </div>
              ))}
            </div>
          </section>
        )}
        {section === "catalog" && (
          <div className="dashboard-catalog">
            <div className="catalog-toolbar">
              <div>
                <strong>{selected.length} selected</strong>
                <span>Only verified apps can be planned.</span>
              </div>
              <label>
                Server name
                <input
                  value={serverName}
                  onChange={(event) => setServerName(event.target.value)}
                />
              </label>
              <label>
                Plan
                <select
                  value={selectedPlan}
                  onChange={(event) => setSelectedPlan(event.target.value)}
                >
                  {config.plans.map((plan) => (
                    <option key={plan.id} value={plan.id}>
                      {plan.label} · {money(plan.monthlyCents)}
                    </option>
                  ))}
                </select>
              </label>
              <button
                className="button primary"
                disabled={!config.plans.some((plan) => plan.id === selectedPlan)}
                onClick={() => void createPlan()}
              >
                {selected.length ? "Save server plan" : "Save Suite-only plan"}
              </button>
            </div>
            <div className="dashboard-app-grid">
              {catalog.map((app) => (
                <button
                  key={app.id}
                  disabled={app.status !== "ready"}
                  className={selected.includes(app.id) ? "selected" : ""}
                  onClick={() =>
                    setSelected((items) =>
                      items.includes(app.id)
                        ? items.filter((id) => id !== app.id)
                        : [...items, app.id],
                    )
                  }
                >
                  <div>
                    <span className="app-monogram">{app.name[0]}</span>
                    <span>
                      {app.status === "ready" ? "Plan ready" : "Verification"}
                    </span>
                  </div>
                  <h3>{app.name}</h3>
                  <p>{app.description}</p>
                  <footer>
                    <span>{app.version}</span>
                    <span>{app.memoryBudgetMb} MB</span>
                  </footer>
                </button>
              ))}
            </div>
          </div>
        )}
        {section === "servers" && (
          <div className="management-grid">
            <ServerTable
              installations={installations}
              catalog={catalog}
              onSelect={setActive}
            />
            {active ? (
              <div className="server-detail">
                <div>
                  <HardDrives />
                  <span>{active.state}</span>
                </div>
                <h2>{active.name}</h2>
                <p>{active.failureReason || active.hostname}</p>
                {active.applications?.map((application) => {
                  const latestBackup = backups.find(
                    (backup) => backup.applicationInstanceId === application.id,
                  );
                  return (
                    <div className="managed-app" key={application.id}>
                      <div>
                        <span>
                          {catalog.find((item) => item.id === application.appId)
                            ?.name ?? application.appId}
                        </span>
                        <small>{application.hostname}</small>
                      </div>
                      <strong>{application.state}</strong>
                      <div className="managed-app-actions">
                        {application.state === "live" ? (
                          <>
                            <a
                              href={`https://${application.hostname}`}
                              target="_blank"
                              rel="noreferrer"
                            >
                              Open <ArrowRight />
                            </a>
                            <button
                              onClick={() =>
                                manageApplication(application.id, "backup")
                              }
                            >
                              Back up
                            </button>
                            <button
                              onClick={() =>
                                manageApplication(application.id, "stop")
                              }
                            >
                              Stop
                            </button>
                          </>
                        ) : (
                          <button
                            onClick={() =>
                              manageApplication(application.id, "start")
                            }
                          >
                            Start
                          </button>
                        )}
                        {latestBackup && (
                          <button
                            onClick={() =>
                              manageApplication(
                                application.id,
                                "restore",
                                latestBackup.objectName,
                              )
                            }
                          >
                            Restore latest
                          </button>
                        )}
                      </div>
                    </div>
                  );
                })}
                <div className="clone-service">
                  <select
                    value={cloneAppId}
                    onChange={(event) => setCloneAppId(event.target.value)}
                  >
                    {catalog
                      .filter((app) => app.status === "ready")
                      .map((app) => (
                        <option key={app.id} value={app.id}>
                          Clone {app.name}
                        </option>
                      ))}
                  </select>
                  <button onClick={cloneService}>
                    <Plus /> Clone service
                  </button>
                </div>
                <div className="capacity-bar">
                  <span>
                    {usedMemory} of {currentPlan?.memoryMb ?? 0} MB ·{" "}
                    {usedStorage} of {currentPlan?.storageGb ?? 0} GB ·{" "}
                    {active.applications?.length ?? 0} of{" "}
                    {currentPlan?.maxServices ?? 0} services
                  </span>
                  <i>
                    <b
                      style={{
                        width: `${Math.min(100, (usedMemory / (currentPlan?.memoryMb || 1)) * 100)}%`,
                      }}
                    />
                  </i>
                </div>
                <p className="quota-enforcement-note">
                  Storage is a logical reservation. Hosted billing remains
                  disabled until every worker proves an operator-managed hard
                  filesystem quota; measurement-only workers stop and
                  quarantine observed overruns but cannot prevent a brief
                  overrun.
                </p>
                <h3>Upgrade capacity</h3>
                <div className="plan-buttons">
                  {config.plans.map((plan) => (
                    <button
                      key={plan.id}
                      disabled={plan.id === active.plan}
                      onClick={() => upgrade(plan.id)}
                    >
                      <strong>
                        {plan.label} · {money(plan.monthlyCents)}
                      </strong>
                      <span>
                        {plan.memoryMb / 1024} GB RAM · {plan.storageGb} GB
                        storage · {plan.maxServices} services
                      </span>
                    </button>
                  ))}
                </div>
              </div>
            ) : (
              <div className="empty-panel">
                <HardDrives />
                <p>Select a server to manage capacity.</p>
              </div>
            )}
          </div>
        )}
        {section === "domains" && (
          <div className="management-grid">
            <ServerTable
              installations={installations}
              catalog={catalog}
              onSelect={setActive}
            />
            {active ? (
              <div className="server-detail">
                <div>
                  <Globe />
                  <span>DNS settings</span>
                </div>
                <h2>{active.name}</h2>
                <p>
                  Add a hostname to generate its unique TXT and CNAME ownership
                  proofs, then verify it here. A platform IP alone never proves
                  ownership.
                </p>
                <label className="domain-input">
                  <input
                    placeholder="tool.yourdomain.com"
                    value={domain}
                    onChange={(event) => setDomain(event.target.value)}
                  />
                  <button onClick={addDomain}>Add domain</button>
                </label>
                <div className="domain-list">
                  {active.customDomains.map((item) => {
                    const ownership = active.applications
                      ?.flatMap((application) => application.customDomains)
                      .find((domain) => domain.domain === item)?.ownership;
                    return (
                    <div key={item}>
                      <span>
                        <i />
                        {item}
                      </span>
                      {ownership && <button
                        onClick={() =>
                          navigator.clipboard.writeText(
                            `${ownership.txt.name} TXT ${ownership.txt.value}`,
                          )
                        }
                      >
                        <Copy /> TXT proof
                      </button>}
                      {ownership && <button
                        onClick={() =>
                          navigator.clipboard.writeText(
                            `${ownership.cname.name} CNAME ${ownership.cname.value}`,
                          )
                        }
                      >
                        <Copy /> CNAME proof
                      </button>}
                      <button onClick={() => verifyDomainName(item)}>
                        Verify DNS
                      </button>
                    </div>
                    );
                  })}
                </div>
              </div>
            ) : (
              <div className="empty-panel">
                <Globe />
                <p>Select a server before adding a domain.</p>
              </div>
            )}
          </div>
        )}
        {section === "billing" && (
          <div className="billing-page">
            <article>
              <CreditCard />
              <span>Billing status</span>
              <h2>
                {config.billingReady
                  ? "Secure checkout ready"
                  : "Safely disabled"}
              </h2>
              <p>
                {config.billingReady
                  ? "Stripe itemizes infrastructure and the management fee. Provisioning begins only after a signed paid webhook."
                  : "Checkout remains disabled until the production webhook and domain are verified end to end."}
              </p>
              <button
                className="button primary"
                disabled={
                  !config.billingReady || !active || active.state !== "planned"
                }
                onClick={startCheckout}
              >
                {active
                  ? `Checkout for ${active.name}`
                  : "Select a planned server"}
              </button>
            </article>
            <article>
              <h3>How each bill is calculated</h3>
              <div>
                <span>Cloud infrastructure</span>
                <strong>Configured allocation</strong>
              </div>
              <div>
                <span>Management fee</span>
                <strong>
                  {config.platformFeePercent}% or{" "}
                  {money(config.platformFeeMinimumCents)} minimum
                </strong>
              </div>
              <div>
                <span>Custom domain</span>
                <strong>Included</strong>
              </div>
            </article>
          </div>
        )}
      </section>
    </main>
  );
}

function ServerTable({
  installations,
  catalog,
  onSelect,
}: {
  installations: Installation[];
  catalog: CatalogApp[];
  onSelect: (item: Installation) => void;
}) {
  return (
    <div className="server-table">
      <div className="table-heading">
        <strong>Your servers</strong>
        <span>{installations.length} total</span>
      </div>
      {installations.length ? (
        installations.map((item) => (
          <button key={item.id} onClick={() => onSelect(item)}>
            <span className="server-icon">
              <HardDrives />
            </span>
            <div>
              <strong>{item.name}</strong>
              <span>
                {item.appIds
                  .map((id) => catalog.find((app) => app.id === id)?.name)
                  .filter(Boolean)
                  .join(", ")}
              </span>
            </div>
            <span className="state">{item.state.replace("_", " ")}</span>
            <ArrowRight />
          </button>
        ))
      ) : (
        <div className="empty-table">
          <Cloud />
          <span>No server plans yet.</span>
        </div>
      )}
    </div>
  );
}
