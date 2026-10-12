"use client";

import Link from "next/link";
import {
  Button,
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@iamthemcmaster/ui";
import { IconLock } from "@tabler/icons-react";
import { AuthBrand } from "@/components/auth-shell";

interface AccessDeniedViewProps {
  /** `not-allowed`: the account may not sign in; `forbidden`: signed in, but not an admin. */
  reason: "not-allowed" | "forbidden";
}

export function AccessDeniedView({ reason }: AccessDeniedViewProps) {
  const forbidden = reason === "forbidden";
  return (
    <>
      <AuthBrand />
      <Card>
        <CardHeader>
          <div className="auth-title-row text-danger-fg">
            <IconLock size={18} />
            <CardTitle as="h1">Access denied</CardTitle>
          </div>
          <CardDescription>
            {forbidden
              ? "This page is only available to admins."
              : "Your account isn't allowed to use this control panel."}
          </CardDescription>
        </CardHeader>
        <CardContent className="text-sm text-text-secondary">
          {forbidden
            ? "Ask an admin of your organization to change your role if you need access."
            : "Sign-in is limited to approved email domains and people invited to an organization. Ask an organization admin to invite your email, then try again."}
        </CardContent>
        <CardFooter>
          <Button asChild variant={forbidden ? "secondary" : "primary"}>
            <Link href={forbidden ? "/" : "/sign-in"}>
              {forbidden ? "Back to the control panel" : "Try another account"}
            </Link>
          </Button>
        </CardFooter>
      </Card>
    </>
  );
}
