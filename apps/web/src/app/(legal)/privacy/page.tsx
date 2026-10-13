import type { Metadata } from "next";
import Link from "next/link";

export const metadata: Metadata = { title: "Privacy policy · Omniralph" };

export default function PrivacyPage() {
  return (
    <article>
      <h1>Privacy policy</h1>
      <p>Last updated: October 9, 2026</p>

      <p>
        This policy explains what this Omniralph deployment (&quot;the service&quot;) collects, why,
        who it is shared with and how long it is kept. Omniralph is self-hosted software; this
        deployment is run by its operator (&quot;we&quot;). Using the service is also subject to the{" "}
        <Link href="/terms">terms of service</Link>.
      </p>

      <h2>What we collect</h2>
      <ul>
        <li>
          <strong>Your account.</strong> When you sign in with GitHub or GitLab: your name, email
          address, profile picture and account ID, and your session. We also store your
          organizations, roles and invitations, your active organization and your theme.
        </li>
        <li>
          <strong>Code-host data.</strong> For repositories an admin connects: repository details,
          pull and merge requests, their diffs and comments, CI results, and webhook events. Agents
          clone and fetch these repositories to review or change them.
        </li>
        <li>
          <strong>Reviews and runs.</strong> Review findings, dismissals and the rules learned from
          them, coding tasks, their stories and messages, jobs and their logs.
        </li>
        <li>
          <strong>Linear data.</strong> For a connected Linear workspace: the issues, epics,
          comments and agent sessions delegated or mentioned to Omniralph.
        </li>
        <li>
          <strong>Chat data.</strong> For a connected Slack workspace or Discord server: the
          workspace or server name; the messages that mention the bot and the replies in its
          threads, with their authors&apos; user IDs and display names; and, in Slack, the email
          address on the author&apos;s profile, used to recognize members of the organization. Other
          messages and direct messages are ignored and not stored. Chat accounts linked to an
          Omniralph account are stored with that link.
        </li>
        <li>
          <strong>Agents.</strong> Agent hosts&apos; names, versions, enrollment and token records,
          and an audit log of their requests.
        </li>
        <li>
          <strong>Credentials.</strong> Integration tokens (such as Slack bot tokens and Linear
          tokens) are stored encrypted.
        </li>
      </ul>

      <h2>Cookies</h2>
      <p>
        The service uses only cookies it needs to work: the sign-in session and short-lived cookies
        that protect integration installs against forgery. There are no advertising or analytics
        cookies.
      </p>

      <h2>How we use it</h2>
      <p>
        Only to provide the service: to sign you in and enforce access, to review code, to build
        Linear issues, to answer questions in chat, to show the organization its data in the control
        panel, and to keep the service secure and running. We don&apos;t sell your data or use it
        for advertising.
      </p>

      <h2>Who we share it with</h2>
      <ul>
        <li>
          <strong>Members of your organization</strong> see the organization&apos;s data. Nobody
          outside the organization sees it, and its jobs only run on its own agents.
        </li>
        <li>
          <strong>AI model providers.</strong> Agents send code, diffs, issues and instructions to
          Anthropic&apos;s Claude to review and write code. Chat questions and the
          organization&apos;s data needed to answer them are sent to a model through the Vercel AI
          Gateway.
        </li>
        <li>
          <strong>Infrastructure providers.</strong> The control panel runs on Vercel and stores
          data in a Postgres database (Neon). Agents run on hosts chosen by the operator.
        </li>
        <li>
          <strong>Connected services.</strong> Reviews, comments, commits, pull and merge requests,
          issue updates and chat replies are posted back to GitHub, GitLab, Linear, Slack and
          Discord, where their own privacy policies apply.
        </li>
        <li>When the law requires it.</li>
      </ul>

      <h2>How long we keep it</h2>
      <p>
        Data is kept while the organization uses the service. Disconnecting a code host, Linear
        workspace, Slack workspace or Discord server revokes its credentials and stops new data from
        it; removing a code-host connection deletes its repositories. Short-lived records, such as
        webhook deliveries, rate limits and one-time link states, are deleted automatically. To have
        an organization or account and its data deleted, ask the operator.
      </p>

      <h2>Security</h2>
      <p>
        Traffic is encrypted in transit, integration credentials are encrypted at rest, agents only
        get short-lived, scoped credentials, and each organization&apos;s data is kept apart from
        the others.
      </p>

      <h2>Your choices and rights</h2>
      <ul>
        <li>
          Unlink a chat account under <strong>Settings › Chat accounts</strong>; an unlinked Slack
          account isn&apos;t linked again by email.
        </li>
        <li>Leave an organization, or ask its admins to remove you.</li>
        <li>
          Ask the operator for a copy of your data, or to correct or delete it. Depending on where
          you live, you may have further rights under data protection laws.
        </li>
      </ul>

      <h2>Changes</h2>
      <p>We may update this policy. The date above shows the latest version.</p>

      <h2>Contact</h2>
      <p>
        Privacy questions and requests go to the operator of this deployment, or to your
        organization&apos;s admins.
      </p>
    </article>
  );
}
