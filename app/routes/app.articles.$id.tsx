import { useParams } from 'react-router'
import { App } from '../screens/App.tsx'

export default function AppArticle() {
  const { id } = useParams()
  return <App key={id} screen="articles" articleId={Number(id)} />
}
