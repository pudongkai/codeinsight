// Package shop 是 SCIP 读取测试用的最小 Go 包。
package shop

// Repo 读取订单。
type Repo interface {
	Find(id int) string
}

// Service 处理订单。
type Service struct {
	repo Repo
}

// NewService 创建 Service。
func NewService(r Repo) *Service {
	return &Service{repo: r}
}

// Get 通过 repo 查订单，
// 函数体跨多行。
func (s *Service) Get(id int) string {
	name := s.repo.Find(id)
	return format(name)
}

func format(name string) string {
	return "order:" + name
}
