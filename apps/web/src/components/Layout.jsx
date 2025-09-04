export default function Layout({ children }) {
  return (
    <div className="min-h-screen bg-gray-100 text-gray-900 flex flex-col">
      <main className="flex-1 p-12">{children}</main>
      <footer className="p-1 text-center text-gray-600">mrodrive ❤️ iru © 2025</footer>
    </div>
  );
}
