# Internal Enterprise Deployment: Siemens Network

Private deployment architecture where **zero data leaves the corporate network**.

---

## Key Insight: VPN Eliminates the Tunnel

Since mobile devices are connected via VPN to the corporate network, phones can reach laptops (or internal servers) directly. **No GitHub tunnel, no Microsoft relay, no external cloud needed.**

```
BEFORE (Public Internet):
  Phone ──► GitHub Tunnel (external) ──► Laptop

AFTER (Corporate VPN):
  Phone ──► [VPN] ──► Internal Server/Laptop (direct)
```

This means:
- Zero data exits the Siemens perimeter
- No dependency on Microsoft/GitHub infrastructure
- Lower latency (internal routing only)
- Corporate firewall controls all access

---

## Option Comparison

| Option | Cost/mo | Complexity | Data Location | Best For |
|--------|---------|-----------|---------------|----------|
| **A: Direct Laptop Access** | $0 | Low | User's laptop only | Small team (<10) |
| **B: Central Relay on AWS** | ~$15 | Medium | AWS (Siemens account) | Medium team (10-200) |
| **C: On-Prem Data Center** | $0* | Medium | Siemens DC | Large org, strict compliance |
| **D: Kubernetes on AWS** | ~$50 | High | AWS (Siemens account) | Enterprise scale (200+) |

*\*If existing infrastructure is available*

---

## Option A: Direct Laptop Access via VPN (Zero Cost)

**How it works:** Each developer's laptop runs the daemon bound to its corporate IP. Phones (on VPN) connect directly.

```
┌─────────────── SIEMENS CORPORATE NETWORK ─────────────────┐
│                                                             │
│  Phone (on VPN)                                            │
│    │                                                        │
│    │  wss://developer-laptop.siemens.net:8080              │
│    │  (or wss://10.x.x.x:8080)                            │
│    ▼                                                        │
│  Developer's Laptop                                        │
│    └── vstunnel daemon (bound to corporate IP)             │
│         └── VS Code + Copilot                              │
│                                                             │
└─────────────────────────────────────────────────────────────┘
```

**Setup per user:**
```bash
# In config/.env, bind to corporate interface instead of localhost:
DAEMON_HOST=0.0.0.0
DAEMON_PORT=8080

# Start daemon
./scripts/start-daemon.sh

# User opens phone browser:
# https://10.45.12.100:8080 (their laptop's VPN IP)
```

**Pros:**
- $0 cost — no infrastructure needed
- Simplest to deploy
- Data never leaves the laptop

**Cons:**
- User must know their laptop's IP (changes with DHCP)
- Must open port 8080 on laptop firewall
- Doesn't work if laptop is asleep/off
- No central discovery — each user manages their own

**Good for:** Quick proof-of-concept, 1-5 developers testing the tool.

---

## Option B: Central Relay Server on AWS (Recommended)

**How it works:** One lightweight EC2 instance acts as a WebSocket relay + discovery service. Laptops register, phones look them up.

```
┌─────────────── SIEMENS AWS ACCOUNT (VPC) ─────────────────┐
│                                                             │
│  ┌─────────────────────────────────────────────────────┐   │
│  │  Relay Server (t3.micro or t4g.small)               │   │
│  │                                                     │   │
│  │  ┌───────────────┐  ┌────────────────────────────┐ │   │
│  │  │ Discovery API │  │ WebSocket Relay            │ │   │
│  │  │ (REST)        │  │ (routes messages between   │ │   │
│  │  │               │  │  phones and laptops)       │ │   │
│  │  │ POST /register│  │                            │ │   │
│  │  │ GET  /lookup  │  │  Phone ◄──► Relay ◄──► PC │ │   │
│  │  └───────────────┘  └────────────────────────────┘ │   │
│  │                                                     │   │
│  │  ┌───────────────┐  ┌────────────────────────────┐ │   │
│  │  │ Mobile UI     │  │ Auth (Corporate SSO)       │ │   │
│  │  │ (Static files)│  │ OIDC / SAML via Siemens ID │ │   │
│  │  └───────────────┘  └────────────────────────────┘ │   │
│  └─────────────────────────────────────────────────────┘   │
│                                                             │
│  Connected via VPN / Direct Connect / Private Link:        │
│                                                             │
│  ┌──────────┐  ┌──────────┐  ┌──────────┐                │
│  │ Laptop 1 │  │ Laptop 2 │  │ Laptop N │                │
│  │ (User A) │  │ (User B) │  │ (User N) │                │
│  └──────────┘  └──────────┘  └──────────┘                │
│                                                             │
└─────────────────────────────────────────────────────────────┘
```

**Cost breakdown:**
| Resource | Spec | Monthly Cost |
|----------|------|-------------|
| EC2 instance | t4g.small (ARM, 2 vCPU, 2GB) | ~$12 |
| EBS storage | 20GB gp3 | ~$2 |
| Data transfer | Internal VPC (in-region) | $0 |
| ALB (optional) | If TLS termination needed | ~$16 |
| **Total (without ALB)** | | **~$14/mo** |
| **Total (with ALB + TLS)** | | **~$30/mo** |

**For even cheaper:** Use a t4g.nano ($3/mo) for <50 users.

**Architecture details:**

The relay server does two things:

1. **Discovery:** Laptops register on startup ("I'm user X, connect to me at ws://relay:8080/session/abc123"). Phones query "where is user X?" and get routed.

2. **Relay (optional):** If laptops can't accept incoming connections (firewall), the relay acts as a message broker. Both laptop and phone connect *outbound* to the relay, which routes messages between them.

```
Laptop connects TO relay: "I'm session abc123, ready for prompts"
Phone connects TO relay:  "Send this prompt to session abc123"
Relay forwards message from phone → laptop
Relay forwards response from laptop → phone
```

This way, **no incoming port needs to be opened on any laptop.**

---

## Option C: On-Prem Data Center Server

**Same as Option B, but runs on a Siemens-managed VM** instead of AWS.

```
┌─────────── SIEMENS DATA CENTER ───────────────────────────┐
│                                                             │
│  VM: vstunnel-relay.siemens.internal                       │
│  ├── Docker container: vstunnel-relay                      │
│  ├── Nginx reverse proxy (TLS with internal CA cert)       │
│  └── Connected to corporate LDAP/AD for auth               │
│                                                             │
└─────────────────────────────────────────────────────────────┘
```

**Pros:**
- Zero cloud cost (uses existing infra)
- IT team manages security/patching
- Integrates with existing monitoring

**Cons:**
- Depends on data center VM provisioning process
- May need IT approval/ticket

---

## Option D: ECS/Kubernetes on AWS (Enterprise Scale)

For 200+ users with HA requirements:

```
┌─────────── AWS VPC (Siemens Account) ─────────────────────┐
│                                                             │
│  ALB (internal) ──► ECS Fargate Service (2+ tasks)        │
│                         │                                   │
│                         ├── Relay container                 │
│                         ├── Mobile UI container (nginx)     │
│                         └── Health checks                   │
│                                                             │
│  ElastiCache (Redis) ── Session store (which laptop where) │
│  CloudWatch ──── Metrics, alarms                           │
│  Cognito ──── SSO integration                              │
│                                                             │
└─────────────────────────────────────────────────────────────┘
```

Cost: ~$50-80/month. Overkill unless you need HA/auto-scaling.

---

## Recommended: Option B (Single EC2 Relay)

Here's the implementation:

### Server Component: `relay-server/`

```
relay-server/
├── server.py          # WebSocket relay + discovery API
├── auth.py            # Corporate SSO / token validation
├── requirements.txt
├── Dockerfile
├── docker-compose.yml
└── nginx.conf         # TLS termination + static files
```

### Flow:

```
1. Developer opens VS Code → extension starts → connects to relay
   Extension sends: {"type": "REGISTER", "user_id": "z003vsvd", "workspace": "my-project"}
   Relay stores: z003vsvd → session_abc123

2. Developer opens phone browser → vstunnel.siemens.internal
   Phone sends: {"type": "CONNECT_TO", "user_id": "z003vsvd"}
   Relay looks up z003vsvd → routes to session_abc123

3. Developer sends prompt from phone
   Phone → Relay → Laptop (all within VPN)
   Laptop → Relay → Phone (response)
```

### Authentication Options:

| Method | Complexity | Integration |
|--------|-----------|-------------|
| **Siemens SSO (OIDC)** | Medium | Best UX — single sign-on from both devices |
| **LDAP/AD token** | Medium | Validates against corporate directory |
| **Pre-shared token** | Low | Generated per user, entered on phone once |
| **mTLS (client certs)** | High | Most secure — device certificates |

**Recommended:** Siemens SSO (OIDC) for the mobile UI + service account token for the VS Code extension.

---

## Security Architecture (Enterprise)

```
┌─────────────── SECURITY LAYERS ──────────────────────────────────────┐
│                                                                        │
│  Layer 1: NETWORK                                                     │
│  ├── All traffic inside VPN/corporate network                        │
│  ├── No public internet exposure                                     │
│  ├── Security group: only VPN CIDR → relay port                     │
│  └── No data egress                                                  │
│                                                                        │
│  Layer 2: TRANSPORT                                                   │
│  ├── TLS with internal CA certificate                                │
│  ├── WSS (WebSocket Secure) for all connections                     │
│  └── Certificate pinning (optional)                                  │
│                                                                        │
│  Layer 3: AUTHENTICATION                                              │
│  ├── Corporate SSO (OIDC/SAML)                                      │
│  ├── Session tokens with TTL                                        │
│  └── Device binding (optional)                                       │
│                                                                        │
│  Layer 4: AUTHORIZATION                                               │
│  ├── User can only reach their own laptop session                   │
│  ├── No cross-user access possible                                  │
│  └── Admin audit log of all connections                              │
│                                                                        │
│  Layer 5: DATA                                                        │
│  ├── Prompts are transient (not persisted on relay)                 │
│  ├── Relay only forwards, never stores message content              │
│  ├── Logs contain metadata only (who connected, when)               │
│  └── Full audit trail for compliance                                 │
│                                                                        │
└────────────────────────────────────────────────────────────────────────┘
```

### What the relay server NEVER sees:
- Source code
- File contents
- Copilot responses
- Editor state

### What the relay server handles:
- Routing: "phone A wants to talk to laptop B"
- Auth: "is this person allowed?"
- Forwarding: encrypted message blobs pass through opaquely

---

## DNS / Networking Setup

### Internal DNS Entry:
```
vstunnel.siemens.internal → 10.x.x.x (relay EC2 private IP)
```

Or if using Route53 private hosted zone:
```
vstunnel.corp.siemens.net → ALB internal DNS
```

### Security Group:
```
Inbound:
  - Port 443 (HTTPS/WSS) from: 10.0.0.0/8 (VPN range)
  - Port 22 (SSH) from: admin CIDR only

Outbound:
  - None needed (relay only accepts incoming connections)
```

### No NAT Gateway needed — all traffic is internal.

---

## Cost Summary: Serving 100 Internal Users

| Component | Implementation | Monthly Cost |
|-----------|---------------|-------------|
| Relay server | t4g.small EC2 (on-demand) | $12 |
| Storage | 20GB EBS | $2 |
| TLS cert | Internal CA (free) or ACM | $0 |
| DNS | Route53 private zone | $0.50 |
| Data transfer | VPC internal | $0 |
| Mobile UI hosting | Same EC2 (nginx) | $0 |
| **Total** | | **~$15/month** |

Or with reserved instance (1yr): **~$8/month**

Or on existing data center VM: **$0/month**

---

## Implementation Roadmap

### Week 1: Relay Server
- Build WebSocket relay (Python asyncio or Node.js)
- Simple token auth (no SSO yet)
- Docker container
- Deploy to EC2 or DC VM

### Week 2: Extension Update
- Modify extension to connect to relay instead of exposing port
- Register workspace on startup
- Reconnect on network change

### Week 3: Mobile UI + Auth
- Deploy mobile UI to relay server (static files)
- Add corporate SSO login flow
- User sees their workspaces after login

### Week 4: Polish + Security Review
- TLS with internal CA
- Audit logging
- Security review with IT team
- Document for users

---

## Quick Proof-of-Concept (Today)

If you want to test immediately without any infrastructure:

```bash
# On your laptop, bind daemon to corporate IP:
DAEMON_HOST=0.0.0.0 DAEMON_PORT=8080 python3 backend/daemon.py

# Find your laptop's VPN IP:
ip addr show | grep "inet 10\."
# Example output: inet 10.45.12.100/24

# On your phone (connected to Siemens VPN):
# Open browser → http://10.45.12.100:8080
# (or serve the frontend separately and point it to ws://10.45.12.100:8080)
```

This works instantly with zero infrastructure — just to prove the concept works over VPN.

---

## Comparison: Why NOT GitHub Tunnels for Enterprise

| Concern | GitHub Tunnels | Internal Relay |
|---------|---------------|----------------|
| Data path | Through Microsoft servers | Stays in Siemens network |
| Compliance | May violate data residency | Fully compliant |
| Availability | Depends on external service | Under your control |
| Authentication | GitHub account | Corporate SSO |
| Audit | Limited | Full control |
| Cost | Free | ~$15/mo |
| Latency | 50-200ms (public internet) | 1-5ms (internal network) |

**For Siemens, the internal relay is clearly the right choice.**

---

## Next Step

I recommend starting with the **relay server implementation**. Want me to build it?

The relay server would be a single Python file (~200 lines) that:
1. Accepts WebSocket connections from laptops ("I'm session X")
2. Accepts WebSocket connections from phones ("Connect me to session X")
3. Routes messages between matched pairs
4. Validates corporate auth tokens
5. Runs in Docker on any EC2 or DC VM
