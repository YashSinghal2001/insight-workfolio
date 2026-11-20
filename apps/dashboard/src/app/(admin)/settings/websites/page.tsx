import Link from "next/link";
import { PageHeader } from "@/components/kit";
import { buttonClass, Card } from "@/components/ui";

/** The website tracking policy is edited on the Websites page, beside the report it governs. */
export default function WebsiteSettingsPage() {
  return (
    <div className="mx-auto flex max-w-5xl flex-col gap-6">
      <PageHeader title="Website policy" />
      <Card>
        <p className="text-sm">
          Website tracking (on or off, retention, the required notice), category rules and the policy history are managed on the
          Websites page, next to the report they apply to.
        </p>
        <Link href="/websites" className={`${buttonClass} mt-3 inline-flex`}>Open website policy</Link>
      </Card>
    </div>
  );
}
