'use server-entry';

import { redirect } from 'nest-can-react';

export default function PermRedirectPage() {
  redirect('/welcome', 301);
  return <p>never rendered</p>;
}
