import { redirect } from "next/navigation"

export default function ApiRootPage() {
  redirect("/health/live")
}
