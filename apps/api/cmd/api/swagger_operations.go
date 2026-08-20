package main

import "net/http"

// The API uses a small number of method-dispatching handlers because the
// standard-library ServeMux keeps the public route table compact. These
// no-op documentation adapters expose the other operations to Swaggo without
// changing runtime routing or authentication behavior.

// swaggerCreateConnectorAccount documents the POST operation of the shared
// connector account handler.
// @Summary Create connector account
// @Tags connectors
// @Accept json
// @Produce json
// @Security CookieAuth
// @Param body body connectorAccountRequest true "Connector account"
// @Success 201 {object} connectorAccountView
// @Failure 400 {object} map[string]string
// @Router /connectors/accounts [post]
func (a *app) swaggerCreateConnectorAccount(w http.ResponseWriter, r *http.Request) {
	a.connectorAccounts(w, r)
}

// swaggerStartConnectorQR documents QR onboarding start.
// @Summary Start connector QR onboarding
// @Tags connectors
// @Accept json
// @Produce json
// @Security CookieAuth
// @Param accountId path string true "Connector account UUID"
// @Success 202 {object} connectorQRView
// @Failure 400 {object} map[string]string
// @Failure 409 {object} map[string]string
// @Router /connectors/accounts/{accountId}/qr [post]
func (a *app) swaggerStartConnectorQR(w http.ResponseWriter, r *http.Request) {
	a.connectorAccountAction(w, r)
}

// swaggerListKnowledgeRebuilds documents the GET operation of the shared
// Knowledge Base rebuild handler.
// @Summary List Knowledge Base rebuild jobs
// @Tags administration
// @Produce json
// @Security CookieAuth
// @Success 200 {array} knowledgeRebuildJobView
// @Failure 403 {object} map[string]string
// @Router /admin/knowledge/topics/rebuild [get]
func (a *app) swaggerListKnowledgeRebuilds(w http.ResponseWriter, r *http.Request) {
	a.adminKnowledgeRebuild(w, r)
}

// swaggerListMessageReassessments documents the GET operation of the shared
// message reassessment handler.
// @Summary List message reassessment jobs
// @Tags ai-learning
// @Produce json
// @Security CookieAuth
// @Success 200 {array} aiReassessmentJobView
// @Failure 403 {object} map[string]string
// @Router /admin/ai-learning/reassessment [get]
func (a *app) swaggerListMessageReassessments(w http.ResponseWriter, r *http.Request) {
	a.adminAILearningReassessment(w, r)
}

// swaggerListThreadReassessments documents the GET operation of the shared
// thread reassessment handler.
// @Summary List thread reassessment jobs
// @Tags ai-learning
// @Produce json
// @Security CookieAuth
// @Success 200 {array} threadReassessmentJobView
// @Failure 403 {object} map[string]string
// @Router /admin/ai-learning/thread-reassessment [get]
func (a *app) swaggerListThreadReassessments(w http.ResponseWriter, r *http.Request) {
	a.adminThreadReassessment(w, r)
}

// swaggerDeleteAILearning documents deletion from the shared learning-term
// dispatcher.
// @Summary Delete AI learning term
// @Tags ai-learning
// @Produce json
// @Security CookieAuth
// @Param id path string true "Learning term UUID"
// @Success 200 {object} map[string]bool
// @Failure 404 {object} map[string]string
// @Router /admin/ai-learning/{id} [delete]
func (a *app) swaggerDeleteAILearning(w http.ResponseWriter, r *http.Request) {
	a.adminAILearning(w, r)
}

// swaggerCreateReplay documents the POST operation of the replay dispatcher.
// @Summary Create replay job
// @Tags replays
// @Accept json
// @Produce json
// @Security CookieAuth
// @Param body body replayRequest true "Replay range and groups"
// @Success 202 {object} replayJobView
// @Failure 400 {object} map[string]string
// @Router /replays [post]
func (a *app) swaggerCreateReplay(w http.ResponseWriter, r *http.Request) {
	a.replays(w, r)
}
