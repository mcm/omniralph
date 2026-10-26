import type { Metadata } from "next";
import Link from "next/link";

export const metadata: Metadata = { title: "Terms of service · Omniralph" };

export default function TermsPage() {
  return (
    <article>
      <h1>Terms of service</h1>
      <p>Last updated: October 9, 2026</p>

      <p>
        These terms govern your use of this Omniralph deployment: the control panel, its agents and
        its integrations with GitHub, GitLab, Linear, Slack and Discord (together, &quot;the
        service&quot;). Omniralph is self-hosted software; this deployment is run by its operator,
        the person or company that set it up (&quot;we&quot;). By signing in, connecting an
        integration or using Om in chat, you agree to these terms and to the{" "}
        <Link href="/privacy">privacy policy</Link>. If you use the service on behalf of an
        organization, you agree to them for that organization.
      </p>

      <h2>The service</h2>
      <p>
        Omniralph reviews pull and merge requests in connected repositories, builds Linear issues
        with Om, its AI (coding tasks), and answers questions about an organization&apos;s runs,
        reviews, jobs, agents and repositories in Slack and Discord. Everything belongs to an
        organization: its members share it, and its admins decide what is connected and enabled.
      </p>

      <h2>Accounts and access</h2>
      <ul>
        <li>
          You sign in with a GitHub or GitLab account. Sign-in is limited to approved email domains
          and invited people, and access can be removed at any time.
        </li>
        <li>
          Keep your accounts secure, and don&apos;t share access or use another person&apos;s
          account. You&apos;re responsible for what is done with your account and for the chat
          accounts you link to it.
        </li>
        <li>
          Organization admins are responsible for the code hosts, repositories, Linear workspaces,
          chat workspaces and servers, and agents they connect, and for having the right to connect
          them.
        </li>
      </ul>

      <h2>Acceptable use</h2>
      <p>You agree not to:</p>
      <ul>
        <li>connect repositories, workspaces or servers you aren&apos;t authorized to connect;</li>
        <li>
          use the service to break the law or the terms of GitHub, GitLab, Linear, Slack, Discord or
          the AI model providers it relies on;
        </li>
        <li>
          try to reach another organization&apos;s data, get around access controls or rate limits,
          or interfere with the service or its agents;
        </li>
        <li>
          use the service to create malware or other harmful code, or to harass or mislead others.
        </li>
      </ul>

      <h2>AI-generated output</h2>
      <p>
        Reviews, code, commits, pull and merge requests and chat answers are produced by AI models
        and can be wrong, incomplete or insecure. Review them before you rely on, merge or deploy
        them. You remain responsible for your code and for what you ship.
      </p>

      <h2>Your content</h2>
      <p>
        You and your organization keep all rights in your code, issues, messages and other content.
        You let the service access, process and store that content only to provide the service, as
        described in the <Link href="/privacy">privacy policy</Link>. Code and content written by Om
        for your organization is yours to use, subject to the licenses of the code it is based on.
      </p>

      <h2>Third-party services</h2>
      <p>
        The service works with GitHub, GitLab, Linear, Slack, Discord, Anthropic&apos;s Claude,
        Vercel and Neon. Your use of those services is governed by their own terms, and we
        aren&apos;t responsible for them.
      </p>

      <h2>Suspension and termination</h2>
      <p>
        You can stop using the service at any time: admins can disconnect integrations and remove
        agents, and members can leave an organization. We may suspend or end access, or disconnect
        an integration, if these terms are broken or to protect the service, its users or third
        parties.
      </p>

      <h2>Disclaimer</h2>
      <p>
        The service is provided &quot;as is&quot; and &quot;as available&quot;, without warranties
        of any kind, express or implied, including merchantability, fitness for a particular purpose
        and non-infringement. We don&apos;t promise that it will be uninterrupted, error-free or
        secure, or that its output will be correct.
      </p>

      <h2>Limitation of liability</h2>
      <p>
        To the extent the law allows, we aren&apos;t liable for indirect, incidental, special,
        consequential or punitive damages, or for lost profits, data or goodwill, arising from your
        use of the service or its output.
      </p>

      <h2>Changes</h2>
      <p>
        We may update these terms. The date above shows the latest version; continuing to use the
        service after a change means you accept it.
      </p>

      <h2>Contact</h2>
      <p>
        Questions about these terms go to the operator of this deployment, or to your
        organization&apos;s admins.
      </p>
    </article>
  );
}
