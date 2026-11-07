function App() {
  return (
    <main className="welcome">
      <h1>Blackboard</h1>
      <p className="intro">
      </p>

      <section className="board-preview" aria-label="Prévia do quadro">
        <div className="board-topline">
        </div>
        <div className="canvas">
        </div>
        <div className="toolbar" aria-hidden="true">
          <span>↖</span><span>✎</span><span>▧</span><span>▣</span><span>＋</span>
        </div>
      </section>
    </main>
  )
}

export default App
