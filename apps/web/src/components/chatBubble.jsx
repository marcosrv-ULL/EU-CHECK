export default function ChatBubble({ text, isUser, role = isUser ? "user" : "assistant" }) {
  return (
    <div className={`my-2 flex ${isUser ? "justify-end" : "justify-start"}`}>
      <div
        className={`max-w-md px-4 py-2 rounded-xl shadow
        ${isUser ? "bg-blue-600 text-white" : "bg-gray-700 text-white"}`}
      >
        {text}
      </div>
    </div>
  );
}
