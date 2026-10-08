// Used only by the contract run to clear the sacrificial dev store; the product never deletes anything.
export const CONTRACT_BLOGS = /* GraphQL */ `
  query ContractBlogs {
    blogs(first: 100) { nodes { id title } }
  }
`

export const BLOG_DELETE = /* GraphQL */ `
  mutation BlogDelete($id: ID!) {
    blogDelete(id: $id) { deletedBlogId userErrors { message } }
  }
`
