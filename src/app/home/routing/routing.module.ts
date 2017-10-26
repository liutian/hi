import { NgModule } from '@angular/core';
import { RouterModule, Routes } from '@angular/router';

import { WelcomeComponent } from 'app/home/welcome/welcome.component';
import { TalkComponent } from 'app/home/talk/talk.component';
import { AuthGuard } from './auth.guard';

const routes: Routes = [
  {
    path: '',
    component: WelcomeComponent
  }, {
    path: 'talk',
    component: TalkComponent,
    canActivate: [AuthGuard]
  }
];

@NgModule({
  imports: [
    RouterModule.forChild(routes),
  ],
  providers: [AuthGuard],
  declarations: []
})
export class RoutingModule { }
