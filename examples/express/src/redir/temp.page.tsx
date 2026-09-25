'use server-entry';

import { redirect } from 'nest-can-react';

export default function TempRedirectPage() {
  redirect('/welcome');
  return <p>never rendered</p>;
}
