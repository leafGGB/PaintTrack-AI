import { redirect } from 'next/navigation';

export default function ZhHome() {
  redirect('/login?next=%2Fzh%2Fstudio');
}
